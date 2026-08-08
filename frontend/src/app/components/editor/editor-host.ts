// src/app/components/editor/editor-host.ts
//
// THE PORT. This file is the whole contract between the timeline editor and whatever
// application hosts it. The editor injects EDITOR_HOST and nothing else from the host;
// re-hosting the editor means writing one class that implements EditorHost, not auditing
// the host's service layer.
//
// Rules for this file:
//   - It must NOT import from the host's services (electron.service, processing.service).
//     A port that references the thing it replaces is not a port.
//   - Every member below exists because something under components/editor/ calls it.
//     Nothing is here speculatively; nothing the editor uses is missing.
//   - Members are grouped by capability. A host may back several groups with one mechanism
//     (AutoCutStudio backs all of them with Electron IPC) — that is the adapter's business.
//
// Types that describe host data live here too, for the same reason: importing them from the
// host would reattach the dependency this file exists to cut.

import { InjectionToken } from '@angular/core';
import { Observable } from 'rxjs';
import { EditorManifest } from '../../models/editor-manifest';

// ── Host data shapes ──────────────────────────────────────────────────────────

/**
 * What one scan of a project folder concluded.
 *
 *   missing       — the folder is not there (unmounted volume, moved, deleted).
 *   unrecognized  — the folder exists but is not a session folder; `error` says exactly why,
 *                   and nothing is ever skipped quietly.
 *   raw           — a master video, not processed yet.
 *   processed     — a compounds zip exists.
 *   edited        — processed, plus edit state.
 */
export interface ProjectScanResult {
  folder: string;
  /** Symlink-resolved absolute path — the identity used to dedupe. null when missing. */
  realPath: string | null;
  exists: boolean;
  state: 'missing' | 'unrecognized' | 'raw' | 'processed' | 'edited';
  masterVideo?: string;
  session?: string;
  cleanName?: string;
  zipPath?: string;
  hasTranscript?: boolean;
  /** Populated for 'unrecognized' (and any scan that failed): the verbatim reason. */
  error?: string;
}

/** The on-disk projects list. Only these three fields are persisted; scans are recomputed. */
export interface ProjectsRegistry {
  version: 1;
  projects: Array<{ path: string; name: string; lastOpened: string }>;
}

/** One long-running processing job, as the editor observes it. */
export interface ProcessingJob {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  progress: number;
  message: string;
  output: string[];
  error?: string;
  /** Structured error text emitted by the backend, preferred over scraped console output. */
  emittedError?: string;
  /** Success payload from the backend (zipPath/clips/session), delivered on completion. */
  results?: any;
  startTime?: Date;
  endTime?: Date;
  currentOperation?: string;
  canSkipCurrent?: boolean;
  subProgress?: number;
  skipDecisions?: any;
}

/** A batch of subjects handed to the host's titling surface. One entry per upload. */
export interface TitleHandoff {
  subjects: string[];
  format?: 'normal' | 'livestream';
  source?: string;
  /** Story-relative chapter times, for the host's saved report only — never model input. */
  chapters?: { timestamp: string; title: string }[];
}

// ── The port ──────────────────────────────────────────────────────────────────

export interface EditorHost {

  // ── Environment ─────────────────────────────────────────────────────────────

  /**
   * True when the host can actually service the calls below. The editor uses this to skip
   * optional probes (model listing) rather than to decide whether to run at all — every
   * other method is expected to REJECT, not resolve empty, when the host cannot serve it.
   */
  isElectron(): boolean;

  // ── Session payload & manifest ──────────────────────────────────────────────

  /**
   * The session this editor instance was opened on, pulled once at startup. null when the
   * window was opened with no payload (the user picks a project from the sidebar instead).
   */
  getEditorPayload(): Promise<{ zipPath: string } | null>;

  /** Pushed equivalent of getEditorPayload: the host asking this editor to load a session. */
  onEditorPayload(callback: (payload: { zipPath: string }) => void): void;

  /** Detach the onEditorPayload listener. Called from ngOnDestroy. */
  removeEditorListeners(): void;

  /** Read the timeline manifest (tracks, segments, frame rate) out of a compounds zip. */
  getEditorManifest(zipPath: string): Promise<EditorManifest>;

  // ── Edit state (the _edits.json sidecar) ────────────────────────────────────

  /** Load the saved edit state for a session, or null if it was never edited. */
  loadEditorEdits(payload: { zipPath: string }): Promise<any | null>;

  /** Persist edit state. Resolves with the path written. */
  saveEditorEdits(payload: { zipPath: string; edits: any }): Promise<{ path: string }>;

  // ── Export ──────────────────────────────────────────────────────────────────

  /**
   * Render the cut list to the host's editorial format (AutoCutStudio: a revised
   * master-hybrid FCPXML). Resolves with the backend's result object
   * ({ path, cutsApplied, micMuteBlocks, … }); REJECTS with the backend's verbatim message,
   * which the editor shows as-is rather than paraphrasing.
   */
  exportEditorCuts(payload: {
    zipPath: string;
    cuts: Array<{ startFrame: number; endFrame: number }>;
    /**
     * Playback ORDER as a partition of the SURVIVORS — the complement of `cuts`, in playback
     * order, ORIGINAL seconds, frame-aligned. Absent = source order.
     */
    sequence?: Array<{ start: number; end: number }>;
    stories?: Array<{ number: number; title: string; regions: Array<{ start: number; end: number }> }>;
    output?: 'fcpxml' | 'transcripts';
    /**
     * Split every mic lane where the SCREEN track has speech and that mic has none, and
     * disable the middle piece. Derived from the transcript, so the export must FAIL LOUDLY
     * without one rather than quietly skip the muting.
     */
    muteMicDuringScreen?: boolean;
  }): Promise<any>;

  // ── Transcription ───────────────────────────────────────────────────────────

  /** Start transcribing a session. Resolves with the job id used to cancel it. */
  transcribeSession(payload: { zipPath: string }): Promise<{ jobId: string }>;

  /** Cancel a running transcription by job id. */
  cancelTranscription(payload: { jobId: string }): Promise<any>;

  /** Progress ticks for the running transcription. */
  onTranscribeProgress(callback: (data: { jobId: string; progress: number; message: string }) => void): void;

  /** Terminal event for a transcription — success or failure, with the verbatim message. */
  onTranscribeComplete(
    callback: (data: { jobId: string; exitCode: number; result: any; errorMessage?: string }) => void
  ): void;

  /** Detach both transcription listeners. Called from ngOnDestroy. */
  removeTranscribeListeners(): void;

  /** Read the transcript sidecar for a session. */
  loadTranscript(payload: { zipPath: string }): Promise<any>;

  // ── Story analysis (LLM) ────────────────────────────────────────────────────

  /** Models the host's local LLM runtime currently offers. */
  ollamaListModels(host?: string): Promise<{ connected: boolean; models: Array<{ id: string; name: string }> }>;

  /**
   * Split a span of transcript into chapters. `consolidate: false` when the span IS one
   * story the user defined — consolidation exists to find the seam BETWEEN stories, so
   * inside a declared story every merge it makes costs the user a marker.
   */
  analyzeStoryChapters(payload: {
    segments: Array<{ text: string; startSeconds: number; endSeconds: number; speaker: 'host' | 'clip' }>;
    model: string;
    host?: string;
    consolidate?: boolean;
  }): Promise<{ chapters: Array<{
    index: number; startSeconds: number; endSeconds: number; label: string; detail: string; verbalCue: boolean;
    /** This start is a raw ±45 s junction, not a mapped quote — no quote could be located. */
    startApprox?: boolean;
    /** The pre-consolidation chapters this one was merged from. Length 1 = never merged. */
    subChapters: Array<{ startSeconds: number; endSeconds: number; label: string; detail: string; startApprox?: boolean }>;
  }> }>;

  /** Suggest one title from a story's subject list (preferred) or raw transcript text. */
  suggestStoryTitle(payload: { text: string | string[]; model: string; host?: string }): Promise<{ title: string }>;

  /** Abort the in-flight analysis at its next boundary. */
  cancelStoryAnalysis(): Promise<{ stopped: boolean }>;

  /** Evict a model from the runtime's memory. Housekeeping — the editor ignores failures. */
  unloadStoryModel(payload: { model: string; host?: string }): Promise<{ ok: boolean }>;

  /** Progress ticks for chapter analysis. */
  onStoryAnalyzeProgress(callback: (p: { phase: string; done: number; total: number }) => void): void;

  /** Detach the analysis-progress listener. Called from ngOnDestroy. */
  removeStoryAnalyzeProgressListener(): void;

  // ── Media ───────────────────────────────────────────────────────────────────

  /**
   * Waveform peaks for a window of one media file, bucketed. Backs the timeline's waveform
   * cache; called many times concurrently, so the host is expected to be cheap or queued.
   */
  alignmentExtractPeaks(opts: {
    filePath: string; startSec: number; durationSec: number; buckets: number
  }): Promise<{ success?: boolean; min?: number[]; max?: number[]; error?: any }>;

  // ── Files & dialogs ─────────────────────────────────────────────────────────

  /** Native open-file dialog. `canceled` is how a user dismissal is reported. */
  selectFile(options?: { title?: string; filters?: any[]; properties?: any[] }):
    Promise<{ canceled: boolean; filePaths: string[] }>;

  /** Native choose-folder dialog. */
  selectDirectory(options?: { title?: string }): Promise<{ canceled: boolean; filePaths: string[] }>;

  /** List a folder (used to offer companion-file candidates next to a master video). */
  readDirectory(dirPath: string): Promise<{ success: boolean; directories?: any[]; files?: any[] }>;

  /** Does this path exist? Used to grey out recents that have gone away. */
  checkFileExists(filePath: string): Promise<{ exists: boolean }>;

  /** Reveal a path in the OS file manager. */
  showInFolder(filePath: string): Promise<any>;

  /**
   * The absolute path behind a dropped File. Separate from File.path, which Electron 32
   * removed; a browser host has no answer here and should throw rather than return ''.
   */
  getPathForFile(file: File): string;

  // ── Projects registry ───────────────────────────────────────────────────────

  /** Read the projects list. A corrupt registry must THROW — never silently reset. */
  readProjectsRegistry(): Promise<ProjectsRegistry>;

  /** Write the projects list back. */
  writeProjectsRegistry(registry: ProjectsRegistry): Promise<{ success: boolean }>;

  /** Classify one folder. The single source of truth for a project's state. */
  scanProjectFolder(folderPath: string): Promise<ProjectScanResult>;

  // ── Processing (turning a raw project into an editable one) ─────────────────

  /** Infer every companion source from a master video's filename. Pre-fills the setup modal. */
  autoDetectAudio(masterVideoPath: string): Promise<{
    success: boolean;
    audioFiles?: { [key: string]: string };
    videoFiles?: { [key: string]: string };
    error?: string;
  }>;

  /**
   * Install state of the host's optional components. The editor reads exactly one of these
   * (`voice-separator-env`) to decide whether the Denoise toggle can be offered.
   */
  listAssets(): Promise<{ success: boolean; components?: any[]; error?: string }>;

  /** Start a processing run with the payload the shared workflow builder produced. */
  startWorkflow(options: any): Promise<void>;

  /** The current job, or null. The editor RENDERS this; it never owns job state. */
  getCurrentJob(): Observable<ProcessingJob | null>;

  /** Cancel the current job. */
  cancelJob(): Promise<void>;

  /** Tell a running job to skip the operation it is on (when the job says it may be skipped). */
  sendSkipSignal(): Promise<void>;

  // ── Host handoffs (OPTIONAL — a host may not have the surface at all) ───────

  /**
   * Push each story to the host's titling queue as its own item.
   *
   * OPTIONAL: this is AutoCutStudio's Metadata tab. A host without one omits the method,
   * and the caller reports that in the same place a failed send is reported — the Send
   * buttons must never appear to work and do nothing.
   */
  sendSubjectsToTitles?(payload: { handoffs: TitleHandoff[] }): Promise<{ success: boolean }>;
}

/**
 * Inject this, not a concrete service. The HOST application provides it
 * (`{ provide: EDITOR_HOST, useClass: … }` in the host's root module) — EditorModule
 * deliberately does not, because the editor must not know any implementation exists.
 */
export const EDITOR_HOST = new InjectionToken<EditorHost>('EDITOR_HOST');
