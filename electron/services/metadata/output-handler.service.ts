/**
 * Output Handler Service
 * Saves metadata to files in user-friendly formats
 */

import * as fs from 'fs';
import * as path from 'path';
import { MetadataResult } from './ai-manager.service';
import { Chapter } from './chapter-generator.service';
import { METADATA_FIELDS } from './metadata-fields';

export interface JobMetadata {
  job_id: string;
  job_name: string;
  prompt_set: string;
  created_at: string;
  txt_folder: string;
  /**
   * Absolute paths of the per-item TXT files written for this job, appended as each item
   * lands. ADDED for AutoCutStudio (ContentStudio's report JSON had only txt_folder): the
   * Reports page reads this list directly, and deriving it by listing txt_folder would
   * mis-attribute files if two jobs ever resolve to the same folder name.
   */
  txt_files?: string[];
  items: MetadataResult[];
  status: string;
  source_items?: any[];
  original_inputs?: string[];  // Raw inputs provided by the user
  input_types?: string[];      // Content types: 'subject' | 'video' | 'transcript_file'
}

export interface SaveJobResult {
  json_file: string;
  txt_folder: string;
  txt_files: string[];
  job_id: string;
}

export class OutputHandlerService {
  private userOutputDir: string;
  private metadataDir: string;
  // Serializes addItemToJob so concurrent calls can't clobber each other's
  // read-modify-write of the job JSON.
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(outputDir: string) {
    this.userOutputDir = outputDir;
    // '.contentstudio' is DELIBERATE, not a leftover from the port. It is the on-disk
    // contract: the Reports page reads <outputDirectory>/.contentstudio/metadata/*.json,
    // and existing users have reports sitting in that directory already. Renaming it to
    // match this app's name would silently empty Reports and orphan every past job.
    this.metadataDir = path.join(outputDir, '.contentstudio', 'metadata');

    // Create directories
    if (!fs.existsSync(this.userOutputDir)) {
      fs.mkdirSync(this.userOutputDir, { recursive: true });
    }
    if (!fs.existsSync(this.metadataDir)) {
      fs.mkdirSync(this.metadataDir, { recursive: true });
    }

    console.log('[OutputHandler] Initialized');
    console.log('[OutputHandler] User output dir:', this.userOutputDir);
    console.log('[OutputHandler] Metadata dir:', this.metadataDir);
  }

  /**
   * Initialize a new job (creates job metadata with empty items)
   */
  initializeJob(
    jobName: string,
    promptSet: string,
    jobId?: string
  ): { jobId: string; txtFolder: string; jsonPath: string } {
    // Generate job ID if not provided
    if (!jobId) {
      const timestamp = Date.now();
      const randomStr = Math.random().toString(36).substring(7);
      jobId = `job-${timestamp}-${randomStr}`;
    }

    // Clean job name for folder
    const cleanFolderName = this.cleanNameWithSpaces(jobName);

    // Create TXT output folder
    const txtFolder = path.join(this.userOutputDir, cleanFolderName);
    if (!fs.existsSync(txtFolder)) {
      fs.mkdirSync(txtFolder, { recursive: true });
    }

    // Prepare initial job metadata
    const jobMetadata: JobMetadata = {
      job_id: jobId,
      job_name: jobName,
      prompt_set: promptSet,
      created_at: new Date().toISOString(),
      txt_folder: txtFolder,
      txt_files: [],
      items: [],
      status: 'processing',
    };

    // Save JSON metadata file
    const jsonPath = path.join(this.metadataDir, `${jobId}.json`);
    this.saveJson(jobMetadata, jsonPath);
    console.log(`[OutputHandler] Job initialized: ${jobId}`);

    return { jobId, txtFolder, jsonPath };
  }

  /**
   * Add a single item to an existing job.
   *
   * Concurrent calls are serialized through a per-instance promise chain so the
   * json read -> push -> write sequence for one item can't clobber another's.
   * Rejects (rather than silently returning null) on a genuine failure so the
   * caller can surface it.
   */
  addItemToJob(
    jobId: string,
    metadataItem: MetadataResult
  ): Promise<{ txtPath: string }> {
    const run = this.writeQueue.then(() => this.writeItemToJob(jobId, metadataItem));
    // Keep the chain alive even if this call rejects, so one failed item doesn't
    // poison the queue for subsequent items.
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Synchronous read-modify-write for a single job item (serialized via writeQueue).
   */
  private writeItemToJob(
    jobId: string,
    metadataItem: MetadataResult
  ): { txtPath: string } {
    // Load existing job
    const job = this.getJobMetadata(jobId);
    if (!job) {
      const message = `Job not found: ${jobId}`;
      console.error(`[OutputHandler] ${message}`);
      throw new Error(message);
    }

    // Add item to job
    job.items.push(metadataItem);

    // Save TXT file for this item. The AI-generated title is untrusted input, so
    // sanitize it for filesystem use and de-collide so untitled/duplicate items
    // don't throw or overwrite each other.
    const rawName = (metadataItem as any)._title || `item_${job.items.length}`;
    const cleanName = this.sanitizeFilename(rawName) || `item_${job.items.length}`;
    const txtPath = this.resolveUniqueTxtPath(job.txt_folder, cleanName);
    this.saveReadable(metadataItem, txtPath, job.prompt_set);

    // Record the TXT path BEFORE writing the JSON, so the report never lists a file that
    // does not exist and never omits one that does.
    job.txt_files = [...(job.txt_files || []), txtPath];

    // Save updated job metadata
    const jsonPath = path.join(this.metadataDir, `${jobId}.json`);
    this.saveJson(job, jsonPath);

    console.log(`[OutputHandler] Added item to job ${jobId}: ${cleanName}`);

    return { txtPath };
  }

  /**
   * Update job status
   */
  updateJobStatus(jobId: string, status: string): boolean {
    try {
      const job = this.getJobMetadata(jobId);
      if (!job) {
        return false;
      }

      job.status = status;

      const jsonPath = path.join(this.metadataDir, `${jobId}.json`);
      this.saveJson(job, jsonPath);

      console.log(`[OutputHandler] Updated job ${jobId} status to: ${status}`);
      return true;
    } catch (error) {
      console.error(`[OutputHandler] Failed to update job status:`, error);
      return false;
    }
  }

  /**
   * Update arbitrary job data fields
   */
  updateJobData(jobId: string, data: Partial<JobMetadata>): boolean {
    try {
      const job = this.getJobMetadata(jobId);
      if (!job) {
        return false;
      }

      Object.assign(job, data);

      const jsonPath = path.join(this.metadataDir, `${jobId}.json`);
      this.saveJson(job, jsonPath);

      console.log(`[OutputHandler] Updated job ${jobId} data`);
      return true;
    } catch (error) {
      console.error(`[OutputHandler] Failed to update job data:`, error);
      return false;
    }
  }

  /**
   * Save metadata for a batch job
   */
  saveJobMetadata(
    jobName: string,
    metadataItems: MetadataResult[],
    promptSet: string,
    jobId?: string,
    sourceItems?: any[]
  ): SaveJobResult {
    if (!metadataItems || metadataItems.length === 0) {
      throw new Error('Metadata items cannot be empty');
    }

    // Generate job ID if not provided
    if (!jobId) {
      const timestamp = Date.now();
      const randomStr = Math.random().toString(36).substring(7);
      jobId = `job-${timestamp}-${randomStr}`;
    }

    // Clean job name for folder
    const cleanFolderName = this.cleanNameWithSpaces(jobName);

    // Create TXT output folder
    const txtFolder = path.join(this.userOutputDir, cleanFolderName);
    if (!fs.existsSync(txtFolder)) {
      fs.mkdirSync(txtFolder, { recursive: true });
    }

    // Prepare job metadata
    const jobMetadata: JobMetadata = {
      job_id: jobId,
      job_name: jobName,
      prompt_set: promptSet,
      created_at: new Date().toISOString(),
      txt_folder: txtFolder,
      txt_files: [],
      items: metadataItems,
      status: 'completed',
    };

    if (sourceItems) {
      jobMetadata.source_items = sourceItems;
    }

    // Save JSON metadata file
    const jsonPath = path.join(this.metadataDir, `${jobId}.json`);
    this.saveJson(jobMetadata, jsonPath);
    console.log(`[OutputHandler] Job metadata saved to: ${jsonPath}`);

    // Save TXT files
    const txtFiles: string[] = [];

    for (const item of metadataItems) {
      // Sanitize the (untrusted) AI title and de-collide so multiple untitled items
      // don't all resolve to "metadata.txt" and overwrite each other.
      const rawName = (item as any)._title || 'metadata';
      const cleanName = this.sanitizeFilename(rawName) || 'metadata';
      const txtPath = this.resolveUniqueTxtPath(txtFolder, cleanName);

      this.saveReadable(item, txtPath, promptSet);
      txtFiles.push(txtPath);
    }

    // Persist the list into the report too, not just the return value — the Reports page
    // reads the JSON, and it never sees what this call returned.
    jobMetadata.txt_files = txtFiles;
    this.saveJson(jobMetadata, jsonPath);

    console.log(`[OutputHandler] TXT files saved to: ${txtFolder}`);

    return {
      json_file: jsonPath,
      txt_folder: txtFolder,
      txt_files: txtFiles,
      job_id: jobId,
    };
  }

  /**
   * Save metadata to JSON file
   */
  private saveJson(metadata: any, outputPath: string): void {
    try {
      fs.writeFileSync(outputPath, JSON.stringify(metadata, null, 2), 'utf-8');
      console.log(`[OutputHandler] JSON saved: ${outputPath}`);
    } catch (error) {
      throw new Error(`Failed to save JSON: ${error}`);
    }
  }

  /**
   * Save metadata as human-readable text file
   */
  private saveReadable(metadata: MetadataResult, outputPath: string, promptSet: string): void {
    try {
      const lines: string[] = [];

      // Header
      lines.push('='.repeat(80));
      lines.push(`METADATA - ${promptSet}`);
      lines.push(`Generated: ${new Date().toLocaleString()}`);
      lines.push('='.repeat(80));
      lines.push('');

      // Emit one section (label line, 80-dash line, content, blank line).
      const emitSection = (label: string, contentLines: string[]): void => {
        lines.push(label);
        lines.push('-'.repeat(80));
        contentLines.forEach((l) => lines.push(l));
        lines.push('');
      };

      // Sections are driven by the field registry so adding a future field is a
      // single entry in metadata-fields.ts. Chapters are not in the registry
      // (typed object array) and are injected right after thumbnail_text.
      for (const def of METADATA_FIELDS) {
        const value = (metadata as any)[def.key];

        if (def.txtStyle === 'numbered') {
          if (Array.isArray(value) && value.length > 0) {
            emitSection(def.txtLabel, value.map((v: string, i: number) => `${i + 1}. ${v}`));
          }
        } else if (def.txtStyle === 'block') {
          if (value) {
            emitSection(def.txtLabel, [value]);
          }
        } else if (def.txtStyle === 'inline') {
          if (Array.isArray(value)) {
            if (value.length > 0) {
              emitSection(def.txtLabel, [value.join(', ')]);
            }
          } else if (value) {
            emitSection(def.txtLabel, [value]);
          }
        }

        // Chapters section - injected in its current position (after thumbnail_text)
        if (def.key === 'thumbnail_text' && metadata.chapters && metadata.chapters.length > 0) {
          emitSection('CHAPTERS', metadata.chapters.map((chapter) => `${chapter.timestamp} - ${chapter.title}`));
        }
      }

      // Write to file
      fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8');
      console.log(`[OutputHandler] TXT saved: ${outputPath}`);
    } catch (error) {
      throw new Error(`Failed to save readable text: ${error}`);
    }
  }

  /**
   * Sanitize an AI-generated title for safe use as a filename.
   * Replaces path separators / reserved characters / control chars with spaces,
   * collapses whitespace, trims, and caps the length (leaving room for a numeric
   * de-collision suffix and the .txt extension).
   */
  private sanitizeFilename(name: string): string {
    let clean = (name || '')
      .replace(/[/\\:*?"<>|\x00-\x1F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const MAX_LEN = 120;
    if (clean.length > MAX_LEN) {
      clean = clean.slice(0, MAX_LEN).trim();
    }

    return clean;
  }

  /**
   * Resolve a collision-free `<baseName>.txt` path inside `dir`, appending a
   * numeric suffix (" (1)", " (2)", ...) if a file with that name already exists.
   */
  private resolveUniqueTxtPath(dir: string, baseName: string): string {
    let candidate = path.join(dir, `${baseName}.txt`);
    let counter = 1;
    while (fs.existsSync(candidate)) {
      candidate = path.join(dir, `${baseName} (${counter}).txt`);
      counter++;
    }
    return candidate;
  }

  /**
   * Clean name for filesystem (keep spaces, remove invalid chars and file extensions)
   */
  private cleanNameWithSpaces(name: string): string {
    // Remove file extension if present (video/audio files)
    const nameWithoutExt = name.replace(/\.(mp4|mov|avi|mkv|webm|m4v|mp3|wav|m4a|txt)$/i, '');

    // Remove invalid filesystem characters but keep spaces
    return nameWithoutExt.replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim();
  }

  /**
   * Get job metadata from file
   */
  getJobMetadata(jobId: string): JobMetadata | null {
    try {
      const jsonPath = path.join(this.metadataDir, `${jobId}.json`);
      if (!fs.existsSync(jsonPath)) {
        return null;
      }

      const content = fs.readFileSync(jsonPath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      console.error(`[OutputHandler] Failed to read job metadata:`, error);
      return null;
    }
  }

  /**
   * List all jobs
   */
  listJobs(): JobMetadata[] {
    try {
      const files = fs.readdirSync(this.metadataDir);
      const jobs: JobMetadata[] = [];

      for (const file of files) {
        if (file.startsWith('job-') && file.endsWith('.json')) {
          const jobId = file.replace('.json', '');
          const job = this.getJobMetadata(jobId);
          if (job) {
            jobs.push(job);
          }
        }
      }

      // Sort by creation date (newest first)
      jobs.sort((a, b) => {
        const dateA = new Date(a.created_at).getTime();
        const dateB = new Date(b.created_at).getTime();
        return dateB - dateA;
      });

      return jobs;
    } catch (error) {
      console.error(`[OutputHandler] Failed to list jobs:`, error);
      return [];
    }
  }

  /**
   * Delete job metadata and files
   */
  deleteJob(jobId: string): boolean {
    try {
      const job = this.getJobMetadata(jobId);
      if (!job) {
        return false;
      }

      // Delete JSON file
      const jsonPath = path.join(this.metadataDir, `${jobId}.json`);
      if (fs.existsSync(jsonPath)) {
        fs.unlinkSync(jsonPath);
      }

      // Delete TXT folder if it exists
      if (job.txt_folder && fs.existsSync(job.txt_folder)) {
        fs.rmSync(job.txt_folder, { recursive: true, force: true });
      }

      console.log(`[OutputHandler] Deleted job: ${jobId}`);
      return true;
    } catch (error) {
      console.error(`[OutputHandler] Failed to delete job:`, error);
      return false;
    }
  }
}
