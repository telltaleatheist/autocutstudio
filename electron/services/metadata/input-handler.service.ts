/**
 * Input Handler Service
 * Processes all input types and normalizes them to content strings
 */

import * as fs from 'fs';
import * as path from 'path';
import * as log from 'electron-log';
import { WhisperService, SRTSegment } from './whisper.service';
import type { TranscriptImportMeta } from './transcript-import.service';
import {
  parseTranscriptImport,
  buildImportedContentItem,
  isTranscriptImportPath,
} from './transcript-import.service';

export interface ContentItem {
  content: string;
  contentType: 'subject' | 'video' | 'transcript_file';
  source?: string;
  processingNotes?: string;
  srtSegments?: SRTSegment[];
  /** Preferred display title (used for the job/TXT name). Set for imported
   *  transcripts so the project reads as the story title rather than a filename. */
  title?: string;
  /** Provenance + speaker/split data for transcripts imported from AutoCutStudio. */
  importMeta?: TranscriptImportMeta;
}

export class InputDetector {
  private static readonly SUPPORTED_MEDIA_FORMATS = new Set([
    // Video formats
    '.mp4', '.avi', '.mov', '.mkv', '.webm', '.m4v', '.flv',
    '.wmv', '.mpg', '.mpeg', '.3gp', '.ogv',
    // Audio formats
    '.mp3', '.wav', '.aiff', '.aif', '.m4a', '.aac', '.flac', '.ogg', '.wma',
  ]);

  /**
   * Detect input type
   */
  static detectInputType(input: string): 'subject' | 'video' | 'directory' | 'transcript_file' {
    // First check: if input has path separators and the file/dir exists, it's definitely a path
    const hasPathSeparators = input.includes('/') || input.includes('\\');

    if (hasPathSeparators && fs.existsSync(input)) {
      const stats = fs.statSync(input);
      if (stats.isFile()) {
        const ext = path.extname(input).toLowerCase();
        if (this.SUPPORTED_MEDIA_FORMATS.has(ext)) {
          return 'video';
        }
        return 'transcript_file';
      } else if (stats.isDirectory()) {
        return 'directory';
      }
    }

    // Check for valid file extensions (not just any period - must be a real extension)
    const ext = path.extname(input).toLowerCase();
    const validFileExtensions = new Set([
      ...this.SUPPORTED_MEDIA_FORMATS,
      '.txt', '.srt', '.vtt', '.json'
    ]);

    // Only treat as file path if it has a recognized file extension
    if (validFileExtensions.has(ext)) {
      if (fs.existsSync(input)) {
        if (this.SUPPORTED_MEDIA_FORMATS.has(ext)) {
          return 'video';
        }
        return 'transcript_file';
      }
      // File doesn't exist but has valid extension - still treat as file path
      if (this.SUPPORTED_MEDIA_FORMATS.has(ext)) {
        return 'video';
      }
      return 'transcript_file';
    }

    // Everything else (including text with periods like sentences) is a subject
    return 'subject';
  }

  /**
   * Validate input
   */
  static validateInput(
    input: string,
    inputType: string,
    maxFileSizeMB: number = 500
  ): { valid: boolean; error?: string } {
    if (inputType === 'subject') {
      if (!input || input.trim().length < 3) {
        return { valid: false, error: 'Subject must be at least 3 characters' };
      }
      if (input.length > 2000) {
        return { valid: false, error: 'Subject too long (max 2000 characters)' };
      }
      return { valid: true };
    }

    if (inputType === 'video' || inputType === 'transcript_file') {
      if (!fs.existsSync(input)) {
        return { valid: false, error: `File not found: ${input}` };
      }

      const stats = fs.statSync(input);
      if (!stats.isFile()) {
        return { valid: false, error: `Path is not a file: ${input}` };
      }
      if (stats.size === 0) {
        return { valid: false, error: `File is empty: ${input}` };
      }

      return { valid: true };
    }

    if (inputType === 'directory') {
      if (!fs.existsSync(input)) {
        return { valid: false, error: `Directory not found: ${input}` };
      }

      const stats = fs.statSync(input);
      if (!stats.isDirectory()) {
        return { valid: false, error: `Path is not a directory: ${input}` };
      }

      return { valid: true };
    }

    return { valid: true };
  }

  /**
   * Check if file should be skipped
   */
  static shouldSkipFile(filePath: string): boolean {
    const filename = path.basename(filePath);

    // Skip macOS metadata files
    if (filename.startsWith('._')) {
      return true;
    }

    // Skip hidden files
    if (filename.startsWith('.')) {
      return true;
    }

    // Skip system files
    if (filename === 'Thumbs.db' || filename === 'desktop.ini') {
      return true;
    }

    return false;
  }
}

export class InputHandlerService {
  private whisperService: WhisperService;
  private progressCallback?: (phase: string, message: string, percent?: number, filename?: string, itemIndex?: number) => void;
  public currentFilename: string = '';
  public currentItemIndex: number = -1;

  constructor(whisperService: WhisperService, progressCallback?: (phase: string, message: string, percent?: number, filename?: string, itemIndex?: number) => void) {
    this.whisperService = whisperService;
    this.progressCallback = progressCallback;
  }

  /**
   * Process a single input item
   */
  async processInput(
    input: string,
    customNotes?: string,
    itemIndex?: number
  ): Promise<ContentItem> {
    console.log(`[InputHandler] Processing input: ${input}`);

    const inputType = InputDetector.detectInputType(input);
    console.log(`[InputHandler] Detected type: ${inputType}`);

    // Validate input
    const validation = InputDetector.validateInput(input, inputType);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    // Process based on type
    if (inputType === 'subject') {
      return this.processSubject(input, customNotes);
    } else if (inputType === 'video') {
      return await this.processVideo(input, customNotes, itemIndex);
    } else if (inputType === 'transcript_file') {
      return this.processTranscriptFile(input, customNotes);
    } else if (inputType === 'directory') {
      throw new Error('Directory processing should be handled by processDirectory()');
    }

    throw new Error(`Unsupported input type: ${inputType}`);
  }

  /**
   * Process a subject string
   */
  private processSubject(subject: string, customNotes?: string): ContentItem {
    console.log(`[InputHandler] Processing subject: ${subject}`);

    let content = subject.trim();

    // Add custom notes if provided
    if (customNotes && customNotes.trim()) {
      content += `\n\nAdditional context:\n${customNotes.trim()}`;
    }

    return {
      content,
      contentType: 'subject',
      source: undefined,
      processingNotes: customNotes?.trim(),
    };
  }

  /**
   * Process a video file
   */
  private async processVideo(videoPath: string, customNotes?: string, itemIndex?: number): Promise<ContentItem> {
    log.info(`[InputHandler] Processing video: ${videoPath}`);

    try {
      // Send 'preparing' event before transcription starts. The item index is
      // threaded in per-call (not read from a shared instance field) so concurrent
      // transcriptions don't attribute progress to the wrong item.
      const filename = path.basename(videoPath);

      if (this.progressCallback) {
        log.info(`[InputHandler] Sending preparing phase for: ${filename}`);
        this.progressCallback('preparing', `Preparing ${filename}`, 0, filename, itemIndex !== undefined && itemIndex >= 0 ? itemIndex : undefined);
      }

      // Transcribe video (returns jobId along with result)
      log.info(`[InputHandler] Calling whisperService.transcribeVideo...`);
      const result = await this.whisperService.transcribeVideo(videoPath);

      log.info(`[InputHandler] [${result.jobId}] Video transcribed: ${result.segments.length} segments`);

      // Convert segments to text
      const transcript = result.segments.map(seg => seg.text).join(' ');

      let content = transcript;

      // Add custom notes if provided
      if (customNotes && customNotes.trim()) {
        content += `\n\nAdditional context:\n${customNotes.trim()}`;
      }

      return {
        content,
        contentType: 'video',
        source: videoPath,
        processingNotes: customNotes?.trim(),
        srtSegments: result.segments,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      log.error(`[InputHandler] Failed to process video: ${errorMessage}`);
      if (errorStack) {
        log.error(`[InputHandler] Stack trace: ${errorStack}`);
      }

      throw new Error(`Failed to transcribe video: ${errorMessage}`);
    }
  }

  /**
   * Process a transcript file
   */
  private processTranscriptFile(filePath: string, customNotes?: string): ContentItem {
    console.log(`[InputHandler] Processing transcript file: ${filePath}`);

    // A .json file is treated as an AutoCutStudio transcript import: parse the
    // word-level data into a fully-timestamped ContentItem (content + srtSegments
    // + speaker attribution) so it lands in the same state a Whisper transcription
    // would, without ever calling Whisper.
    if (isTranscriptImportPath(filePath)) {
      return this.processTranscriptImport(filePath, customNotes);
    }

    try {
      let content = fs.readFileSync(filePath, 'utf-8');

      // Clean up common transcript artifacts
      content = this.cleanTranscript(content);

      // Add custom notes if provided
      if (customNotes && customNotes.trim()) {
        content += `\n\nAdditional context:\n${customNotes.trim()}`;
      }

      console.log(`[InputHandler] Transcript loaded: ${content.length} characters`);

      return {
        content,
        contentType: 'transcript_file',
        source: filePath,
        processingNotes: customNotes?.trim(),
      };
    } catch (error) {
      console.error(`[InputHandler] Failed to read transcript file:`, error);
      throw new Error(`Failed to read transcript file: ${error}`);
    }
  }

  /**
   * Process an AutoCutStudio transcript import (.json).
   * Parses the word-level transcript into a ContentItem with plain-text content,
   * timestamped srtSegments (grouped from words), and preserved mic/screen
   * speaker attribution. Whisper is never invoked.
   */
  private processTranscriptImport(filePath: string, customNotes?: string): ContentItem {
    log.info(`[InputHandler] Importing transcript: ${filePath}`);

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch (error) {
      throw new Error(`Failed to read transcript file: ${error instanceof Error ? error.message : String(error)}`);
    }

    const parsed = parseTranscriptImport(raw, filePath);
    if (!parsed.ok) {
      throw new Error(`Invalid transcript import: ${parsed.error}`);
    }

    const item = buildImportedContentItem(parsed.data, filePath, customNotes);
    log.info(
      `[InputHandler] Imported "${item.title}": ${item.srtSegments?.length ?? 0} segments, ` +
      `${item.content.length} chars, speakers=[${parsed.data.meta.speakers.map(s => s.id).join(', ')}]`
    );
    return item;
  }

  /**
   * Clean transcript text
   */
  private cleanTranscript(text: string): string {
    // Remove excessive whitespace
    text = text.replace(/\s+/g, ' ');

    // Remove common artifacts
    text = text.replace(/\[MUSIC\]/gi, '');
    text = text.replace(/\[APPLAUSE\]/gi, '');
    text = text.replace(/\[LAUGHTER\]/gi, '');

    return text.trim();
  }

  /**
   * Process a directory of files
   */
  async processDirectory(dirPath: string): Promise<ContentItem[]> {
    console.log(`[InputHandler] Processing directory: ${dirPath}`);

    const items: ContentItem[] = [];
    const files = fs.readdirSync(dirPath);

    for (const file of files) {
      const filePath = path.join(dirPath, file);

      // Skip files that should be skipped
      if (InputDetector.shouldSkipFile(filePath)) {
        continue;
      }

      const stats = fs.statSync(filePath);

      if (stats.isFile()) {
        try {
          const item = await this.processInput(filePath);
          items.push(item);
        } catch (error) {
          console.error(`[InputHandler] Failed to process file ${filePath}:`, error);
          // Continue with other files
        }
      }
    }

    console.log(`[InputHandler] Processed ${items.length} files from directory`);
    return items;
  }

  /**
   * Process multiple inputs.
   *
   * Inputs that fail (e.g. transcription produced no speech segments) are skipped
   * so the rest of the batch still processes; when `failures` is provided, a
   * "<input>: <reason>" entry is pushed for each skip so the caller can surface
   * them instead of items silently vanishing from the job.
   */
  async processMultipleInputs(
    inputs: string[],
    customNotesMap?: Map<string, string>,
    failures?: string[]
  ): Promise<ContentItem[]> {
    console.log(`[InputHandler] Processing ${inputs.length} inputs (max 5 concurrent transcriptions)`);

    const items: ContentItem[] = [];
    const MAX_CONCURRENT = 5;

    // Process inputs with concurrency limit
    const processInput = async (input: string, index: number): Promise<ContentItem | null> => {
      try {
        // Thread the item index through the call chain (per-task) so that under the
        // concurrent processing loop below, progress events are attributed to the
        // correct item rather than to whichever task last wrote a shared field.
        const inputType = InputDetector.detectInputType(input);

        if (inputType === 'directory') {
          const dirItems = await this.processDirectory(input);
          return dirItems[0] || null; // Return first item (directories processed separately)
        } else {
          const customNotes = customNotesMap?.get(input);
          return await this.processInput(input, customNotes, index);
        }
      } catch (error) {
        console.error(`[InputHandler] Failed to process input ${input}:`, error);
        const reason = error instanceof Error ? error.message : String(error);
        const label = input.includes('/') || input.includes('\\')
          ? path.basename(input)
          : input.slice(0, 60);
        failures?.push(`${label}: ${reason}`);
        return null;
      }
    };

    // Process items with concurrency limit
    const executing = new Set<Promise<void>>();

    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];

      const promise = processInput(input, i).then(item => {
        if (item) items.push(item);
      }).finally(() => {
        executing.delete(promise);
      });

      executing.add(promise);

      // Wait if we've reached max concurrency
      if (executing.size >= MAX_CONCURRENT) {
        await Promise.race(executing);
      }
    }

    // Wait for all remaining promises to complete
    await Promise.all(executing);

    console.log(`[InputHandler] Processed ${items.length} content items`);
    return items;
  }

  /**
   * Get transcript from content item as plain text
   */
  getTranscriptText(item: ContentItem): string {
    // Remove any custom notes that were appended
    if (item.processingNotes) {
      const notesMarker = `\n\nAdditional context:\n${item.processingNotes}`;
      if (item.content.endsWith(notesMarker)) {
        return item.content.slice(0, -notesMarker.length);
      }
    }

    return item.content;
  }
}
