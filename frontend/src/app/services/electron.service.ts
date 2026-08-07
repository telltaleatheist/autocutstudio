// src/app/services/electron.service.ts
import { Injectable, NgZone } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { EditorManifest } from '../models/editor-manifest';

/** Which trained system prompt the title model is called with. */
export type TitleFormat = 'normal' | 'livestream';
/** How good a title the model is asked to aim for. `top-decile` is the working default. */
export type TitleTarget = 'top-decile' | 'strong' | 'typical' | 'weak';

/**
 * One story's title candidates as they are PERSISTED — the record the Metadata page writes
 * to `<outputDirectory>/.contentstudio/metadata/` when a titling job finishes.
 *
 * The field names are the metadata report store's (`items[]`, `_title`, `titles[]`), because
 * the Reports page parses them and is not changed for this. Everything alongside `titles` is
 * provenance that the Reports viewer ignores. Mirrors TitleReport in
 * electron/services/metadata/title-report.service.ts.
 */
export interface TitleReportItem {
  /** The story's name — the Reports list shows this as the row title. */
  _title: string;
  /** GENERATION order, not the in-band-first order the page displays. */
  titles: string[];
  generator: string;
  kind: 'story-titles';
  model: string;
  format: TitleFormat;
  target: TitleTarget;
  /** The subject lines the model actually saw, as the main process parsed them. */
  subjects: string[];
  titleBand: { min: number; max: number };
  /** Indexes into `titles` that fell outside the band. */
  outOfBand: number[];
  generatedAt: string;
  /**
   * The video's chapter list, story-relative — the Reports viewer's own `ParsedMetadata.chapters`
   * shape. Absent when the run had none (a typed subject list, or the editor's title-only
   * fallback). Report-only: the titling model never sees a timestamp.
   */
  chapters?: Array<{ timestamp: string; title: string; sequence: number }>;
  // RESERVED and deliberately absent until their adapters ship: description and tags
  // (the description adapter will later render `chapters` INTO the description).
}

export interface TitleReport {
  job_id: string;
  job_name: string;
  created_at: string;
  /** Empty on purpose: a titling run writes no TXT files and owns no output folder. */
  txt_folder: string;
  txt_files: string[];
  status: string;
  kind: 'story-titles';
  generator: string;
  items: TitleReportItem[];
}

/** A subject list handed from the editor window to the main window's Titles tab. */
export interface TitleHandoff {
  subjects: string[];
  format: TitleFormat;
  /** Human label for where it came from (a story title), shown as provenance in the tab. */
  source?: string;
  /**
   * The story's chapters with times relative to THAT story's exported video. Rides alongside
   * `subjects` for the saved title report only — it is never added to the model's input, which
   * stays timestamp-free. Absent when the editor sent a title-only fallback.
   */
  chapters?: { timestamp: string; title: string }[];
}

/**
 * What the main process makes of one project FOLDER on disk.
 *
 * `state` is the whole story:
 *   missing       — the folder (or its volume) is not there. The entry is KEPT and greyed;
 *                   it comes back by itself when the drive is mounted again.
 *   unrecognized  — the folder exists but holds no unambiguous `<prefix> master.<ext>` video.
 *                   `error` says exactly why; nothing is ever skipped quietly.
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

@Injectable({
  providedIn: 'root'
})
export class ElectronService {
  private workflowOutput$ = new Subject<{ jobId: string; type: string; data: string }>();
  private workflowComplete$ = new Subject<{ jobId: string; exitCode: number; result?: any }>();
  // Manual-alignment wizard results relayed from the second window (main-window side).
  private alignmentComplete$ = new Subject<{ overrides: any }>();
  private alignmentCancelled$ = new Subject<{ reason?: string }>();
  // Editor → Titles handoff (main-window side). A BATCH — the editor sends one handoff per
  // picked story. Cached as well as emitted: the push can land long before the Titles tab is
  // routed to, and a handoff must not be lost because nobody was subscribed yet. Cleared by
  // takePendingTitleSubjects() — delivered once, not replayed.
  private titleSubjects$ = new Subject<TitleHandoff[]>();
  private pendingTitleSubjects: TitleHandoff[] = [];

  constructor(private ngZone: NgZone) {
    // Set up event listeners
    if (this.isElectron()) {
      window.electron.onWorkflowOutput((data) => {
        // Run inside Angular zone to trigger change detection
        this.ngZone.run(() => {
          console.log('[ElectronService] Received workflow-output, emitting to subscribers:', data);
          this.workflowOutput$.next(data);
        });
      });

      window.electron.onWorkflowComplete((data) => {
        // Run inside Angular zone to trigger change detection
        this.ngZone.run(() => {
          console.log('[ElectronService] Received workflow-complete, emitting to subscribers:', data);
          this.workflowComplete$.next(data);
        });
      });

      window.electron.onAlignmentComplete((data) => {
        this.ngZone.run(() => this.alignmentComplete$.next(data));
      });
      window.electron.onAlignmentCancelled((data) => {
        this.ngZone.run(() => this.alignmentCancelled$.next(data));
      });

      // Registered at bootstrap (this service is root-provided and constructed with the app
      // shell), so a handoff from the editor window can never arrive before someone is
      // listening. Also runs in the editor window, where nothing ever sends it — harmless.
      this.bridge?.onTitlesSubjects?.((hs: TitleHandoff[]) => {
        this.ngZone.run(() => {
          // The push carries the main process's WHOLE undelivered queue, so this replaces the
          // cache rather than appending to it — appending would count a still-parked handoff
          // twice and add the same story to the item list on both deliveries.
          this.pendingTitleSubjects = hs;
          this.titleSubjects$.next(hs);
        });
      });
    }
  }

  getAlignmentComplete(): Observable<{ overrides: any }> {
    return this.alignmentComplete$.asObservable();
  }

  getAlignmentCancelled(): Observable<{ reason?: string }> {
    return this.alignmentCancelled$.asObservable();
  }

  // Measure per-source alignment offsets without generating (pre-seeds the wizard).
  async measureAlignment(options: any): Promise<{ success: boolean; sources?: { audio: any; video: any }; error?: string }> {
    if (!this.isElectron()) {
      throw new Error('Not running in Electron');
    }
    return window.electron.measureAlignment(options);
  }

  // Open the manual-alignment wizard window with a seed payload.
  async openAlignment(payload: any): Promise<{ success: boolean; error?: string }> {
    if (!this.isElectron()) {
      throw new Error('Not running in Electron');
    }
    return window.electron.openAlignment(payload);
  }

  // --- Alignment wizard renderer-side helpers (used inside the wizard window) ---
  async getAlignmentPayload(): Promise<{ success: boolean; payload?: any }> {
    return window.electron.getAlignmentPayload();
  }
  async completeAlignment(overrides: any): Promise<{ success: boolean }> {
    return window.electron.completeAlignment(overrides);
  }
  async cancelAlignment(): Promise<{ success: boolean }> {
    return window.electron.cancelAlignment();
  }
  async alignmentScanActivity(filePath: string) {
    return window.electron.alignmentScanActivity(filePath);
  }
  async alignmentExtractPeaks(opts: { filePath: string; startSec: number; durationSec: number; buckets: number }) {
    return window.electron.alignmentExtractPeaks(opts);
  }
  async alignmentExtractSamples(opts: { filePath: string; startSec: number; durationSec: number; sampleRate: number }) {
    return window.electron.alignmentExtractSamples(opts);
  }
  onAlignmentPayload(callback: (payload: any) => void): void {
    if (this.isElectron()) {
      window.electron.onAlignmentPayload((p) => this.ngZone.run(() => callback(p)));
    }
  }
  removeAlignmentListeners(): void {
    if (this.isElectron()) {
      window.electron.removeAlignmentListeners();
    }
  }

  // --- Timeline editor bridge -----------------------------------------------
  // These methods are exposed by preload.ts at runtime (openEditor / getEditorPayload /
  // getEditorManifest / onEditorPayload / removeEditorListeners). The frontend's
  // ElectronAPI type declaration (src/types/electron.d.ts) is owned elsewhere and does
  // not yet list them, so the bridge is reached through a loose cast — the same runtime
  // object, typed here where the wrappers live. No silent fallback: outside Electron we
  // throw rather than pretend the editor opened.
  private get bridge(): any {
    return (window as any).electron;
  }

  /**
   * Open (or focus) the editor window. With a zipPath, the window loads that session;
   * with none (the side-nav Editor button), it opens on its no-session empty state and
   * the user picks a project in-window.
   */
  async openEditor(payload: { zipPath?: string } = {}): Promise<{ success: boolean; error?: string }> {
    if (!this.isElectron()) {
      throw new Error('Not running in Electron');
    }
    return this.bridge.openEditor(payload);
  }

  /** (Editor window) Pull the zip path this window was opened with — null for a blank open. */
  async getEditorPayload(): Promise<{ zipPath: string } | null> {
    if (!this.isElectron()) {
      throw new Error('Not running in Electron');
    }
    return this.bridge.getEditorPayload();
  }

  /** (Editor window) Ask Python to parse the master hybrid timeline into a manifest. */
  async getEditorManifest(zipPath: string): Promise<EditorManifest> {
    if (!this.isElectron()) {
      throw new Error('Not running in Electron');
    }
    return this.bridge.getEditorManifest(zipPath);
  }

  /**
   * (Editor window) Export a cut list to a revised master-hybrid FCPXML. Resolves with the
   * Python export_result object ({ path, cutsApplied, newDurationSeconds, … }); rejects with
   * Python's verbatim message on failure. Bridge added in preload.ts.
   */
  async exportEditorCuts(payload: {
    zipPath: string;
    cuts: Array<{ startFrame: number; endFrame: number }>;
    // Playback ORDER as a partition of the SURVIVORS — the complement of `cuts`, in playback
    // order, ORIGINAL seconds, frame-aligned. NOT the editor's internal slot partition of the
    // whole timeline; the exporter validates against the cut complement and rejects the other.
    // Absent = source order, which is what every project that was never reordered sends.
    sequence?: Array<{ start: number; end: number }>;
    stories?: Array<{ number: number; title: string; regions: Array<{ start: number; end: number }> }>;
    output?: 'fcpxml' | 'transcripts';
    // Split every mic lane at the boundaries of each stretch where the SCREEN track has
    // speech and that mic has none, and mark the middle piece enabled="0" (FCPX's disabled
    // clip). Derived from the Whisper transcript sidecar, so the export FAILS LOUDLY when
    // there is no sidecar rather than quietly skipping the muting.
    muteMicDuringScreen?: boolean;
  }): Promise<any> {
    if (!this.isElectron()) {
      throw new Error('Not running in Electron');
    }
    return this.bridge.exportEditorCuts(payload);
  }

  /** Load the editor edit-state sidecar (<session>_edits.json), or null if never edited. */
  async loadEditorEdits(payload: { zipPath: string }): Promise<any | null> {
    if (!this.isElectron()) throw new Error('Not running in Electron');
    return this.bridge.loadEditorEdits(payload);
  }

  /** Persist the editor edit-state sidecar (atomic write next to the zip). */
  async saveEditorEdits(payload: { zipPath: string; edits: any }): Promise<{ path: string }> {
    if (!this.isElectron()) throw new Error('Not running in Electron');
    return this.bridge.saveEditorEdits(payload);
  }

  /** (Editor window) Push half of the race-free payload pull. */
  onEditorPayload(callback: (payload: { zipPath: string }) => void): void {
    if (this.isElectron()) {
      this.bridge.onEditorPayload((p: { zipPath: string }) => this.ngZone.run(() => callback(p)));
    }
  }

  removeEditorListeners(): void {
    if (this.isElectron()) {
      this.bridge.removeEditorListeners();
    }
  }

  // --- Transcription bridge (editor window) ----------------------------------
  // Same loose-cast pattern as the editor bridge above; typed in electron.d.ts.

  /** Start a Whisper transcription job for a session; resolves with its job id immediately. */
  async transcribeSession(payload: { zipPath: string }): Promise<{ jobId: string }> {
    if (!this.isElectron()) {
      throw new Error('Not running in Electron');
    }
    return this.bridge.transcribeSession(payload);
  }

  /** Cancel a running transcription job (SIGTERM; no partial sidecar is left behind). */
  async cancelTranscription(payload: { jobId: string }): Promise<any> {
    if (!this.isElectron()) {
      throw new Error('Not running in Electron');
    }
    return this.bridge.cancelTranscription(payload);
  }

  /** Load a session's transcript sidecar; resolves null when none exists (a normal state). */
  async loadTranscript(payload: { zipPath: string }): Promise<any> {
    if (!this.isElectron()) {
      throw new Error('Not running in Electron');
    }
    return this.bridge.loadTranscript(payload);
  }

  onTranscribeProgress(callback: (data: { jobId: string; progress: number; message: string }) => void): void {
    if (this.isElectron()) {
      this.bridge.onTranscribeProgress((d: any) => this.ngZone.run(() => callback(d)));
    }
  }

  onTranscribeComplete(callback: (data: { jobId: string; exitCode: number; result: any; errorMessage?: string }) => void): void {
    if (this.isElectron()) {
      this.bridge.onTranscribeComplete((d: any) => this.ngZone.run(() => callback(d)));
    }
  }

  removeTranscribeListeners(): void {
    if (this.isElectron()) {
      this.bridge.removeTranscribeListeners();
    }
  }

  // --- Story analysis bridge (local Ollama LLM) ------------------------------
  // Chapter splitting + title suggestions for Story Mode. Same loose-cast bridge
  // pattern. Outside Electron these throw rather than pretend a model ran.

  /** List locally-installed Ollama models for the Story-mode model picker. */
  async ollamaListModels(host?: string): Promise<{ connected: boolean; models: Array<{ id: string; name: string }> }> {
    if (!this.isElectron()) throw new Error('Not running in Electron');
    return this.bridge.ollamaListModels(host ? { host } : undefined);
  }

  /**
   * Split a span of transcript segments into consecutive subject chapters.
   *
   * Pass `consolidate: false` when the span IS one story the user has defined. Consolidation
   * exists to find the seam between two stories; inside a declared story there is no such seam,
   * so every merge it makes flattens two real chapters into one and costs the user a marker.
   */
  async analyzeStoryChapters(payload: {
    segments: Array<{ text: string; startSeconds: number; endSeconds: number; speaker: 'host' | 'clip' }>;
    model: string;
    host?: string;
    consolidate?: boolean;
  }): Promise<{ chapters: Array<{
    index: number; startSeconds: number; endSeconds: number; label: string; detail: string; verbalCue: boolean;
    /** This start is a raw ±45 s junction, not a mapped quote — no quote for it could be located.
     *  Surface it: a description built from approximate starts is indistinguishable from a good
     *  one, and the only symptom is a viewer landing half a minute off the marker they clicked. */
    startApprox?: boolean;
    /** The pre-consolidation chapters this one was merged from — the fine tier, retained for
     *  YouTube description markers and title-model conditioning. Length 1 = never merged. */
    subChapters: Array<{ startSeconds: number; endSeconds: number; label: string; detail: string; startApprox?: boolean }>;
  }> }> {
    if (!this.isElectron()) throw new Error('Not running in Electron');
    return this.bridge.analyzeStoryChapters(payload);
  }

  /**
   * Suggest a single title for one story. `text` takes the story's SUBJECT LIST (its chapter
   * labels, in order) as well as raw transcript text — the main process picks its prompt from the
   * shape. Prefer the list: it is the whole story rather than a 12k-char splice, and it is the
   * conditioning shape the fine-tuned titling adapter uses, so the working title previews it.
   */
  async suggestStoryTitle(payload: { text: string | string[]; model: string; host?: string }): Promise<{ title: string }> {
    if (!this.isElectron()) throw new Error('Not running in Electron');
    return this.bridge.suggestStoryTitle(payload);
  }

  /** Stop the in-flight analysis (chapter split or title suggestion). No-op when nothing runs. */
  async cancelStoryAnalysis(): Promise<{ stopped: boolean }> {
    if (!this.isElectron()) throw new Error('Not running in Electron');
    return this.bridge.cancelStoryAnalysis();
  }

  /** Evict a model from Ollama's memory once the renderer is done with it. */
  async unloadStoryModel(payload: { model: string; host?: string }): Promise<{ ok: boolean }> {
    if (!this.isElectron()) throw new Error('Not running in Electron');
    return this.bridge.unloadStoryModel(payload);
  }

  /** Per-step progress of a running chapter analysis — one step per model call, so hundreds on a
   *  long recording (stretch labels, junction ratings, placements, chapter names, merges). */
  onStoryAnalyzeProgress(callback: (p: { phase: string; done: number; total: number }) => void): void {
    if (this.isElectron()) {
      this.bridge.onStoryAnalyzeProgress((p: any) => this.ngZone.run(() => callback(p)));
    }
  }

  removeStoryAnalyzeProgressListener(): void {
    if (this.isElectron()) {
      this.bridge.removeStoryAnalyzeProgressListener();
    }
  }

  // --- Titles bridge (local fine-tuned title model via Ollama) ---------------
  // Same loose-cast pattern as the editor/story bridges above. Outside Electron these
  // throw rather than pretend a model ran.

  /**
   * Generate title suggestions from a pasted/handed-over subject list. `text` is the RAW
   * block — bullets and timestamps are stripped in the main process so there is one
   * implementation of that rule; the parsed `subjects` come back so the UI can show the
   * user exactly what the model was given.
   */
  async generateTitles(payload: {
    text: string;
    format: TitleFormat;
    target: TitleTarget;
    count?: number;
    model?: string;
    host?: string;
  }): Promise<{ titles: string[]; subjects: string[]; model: string }> {
    if (!this.isElectron()) throw new Error('Not running in Electron');
    return this.bridge.generateTitles(payload);
  }

  /** Stop an in-flight title run. No-op (`stopped: false`) when nothing is running. */
  async cancelTitles(): Promise<{ stopped: boolean }> {
    if (!this.isElectron()) throw new Error('Not running in Electron');
    return this.bridge.cancelTitles();
  }

  /**
   * Persist a finished titling run into the metadata report store, so the Reports page lists
   * it long after the queue row is gone.
   *
   * `saved: false` is NOT an error — it means no output directory is configured, and a
   * titling run is allowed to happen without one. A real write failure REJECTS with the
   * main process's message.
   */
  async saveTitleReport(report: TitleReport): Promise<{ saved: true; path: string } | { saved: false; reason: string }> {
    if (!this.isElectron()) throw new Error('Not running in Electron');
    return this.bridge.saveTitleReport(report);
  }

  /** Evict the title model from Ollama's memory (leaving the tab). Never throws in main. */
  async unloadTitleModel(payload?: { model?: string; host?: string }): Promise<{ ok: boolean }> {
    if (!this.isElectron()) throw new Error('Not running in Electron');
    return this.bridge.unloadTitleModel(payload);
  }

  /** One tick per completion; `title` present only when that completion produced a new unique one. */
  onTitlesProgress(callback: (p: { done: number; total: number; title?: string }) => void): void {
    if (this.isElectron()) {
      this.bridge.onTitlesProgress((p: any) => this.ngZone.run(() => callback(p)));
    }
  }

  removeTitlesProgressListener(): void {
    if (this.isElectron()) {
      this.bridge.removeTitlesProgressListener();
    }
  }

  /**
   * Editor-window side of the handoff: push one handoff per story to the main window's Titles
   * tab. Sent as a batch so several picked stories arrive as one delivery — the main process
   * queues them and the tab adds each as its own item.
   *
   * `chapters` rides along for the saved title report only; it is never joined to `subjects`,
   * which are the only lines the titling model is shown.
   */
  async sendSubjectsToTitles(payload: {
    handoffs: {
      subjects: string[];
      format?: TitleFormat;
      source?: string;
      chapters?: { timestamp: string; title: string }[];
    }[];
  }): Promise<{ success: boolean }> {
    if (!this.isElectron()) throw new Error('Not running in Electron');
    return this.bridge.sendSubjectsToTitles(payload);
  }

  /**
   * Main-window side of the handoff. The push arrives on 'titles:subjects' — cached below the
   * moment this service is constructed, long before the Titles tab is ever routed to — and is
   * ALSO parked in the main process for a race-free pull. Either way it is delivered ONCE.
   * Empty array = nothing was waiting.
   */
  async takePendingTitleSubjects(): Promise<TitleHandoff[]> {
    if (!this.isElectron()) return [];
    const cached = this.pendingTitleSubjects;
    this.pendingTitleSubjects = [];
    // Always drain the main-process park too, even when the cache hit: leaving it there would
    // make the NEXT visit to the tab replay a handoff the user already received. The two hold
    // the same queue (the push mirrors the park), so this picks one — it never concatenates.
    const parked = await this.bridge.takePendingTitleSubjects();
    return cached.length ? cached : (parked ?? []);
  }

  /** Fires when the editor hands subject lists over while the app is already running. */
  getTitleSubjectsHandoff(): Observable<TitleHandoff[]> {
    return this.titleSubjects$.asObservable();
  }

  // --- Metadata bridge (ported from ContentStudio) ---------------------------
  // Same loose-cast pattern as the editor/story/titles bridges above. The channel names and
  // payload shapes behind these are ContentStudio's, unchanged, because the main-process
  // half is the same code ported alongside this — see electron/preload.ts for the one
  // forced rename ('cancel-job' → 'metadata:cancel-job').
  //
  // Doctrine: outside Electron these THROW. A metadata run that quietly resolved
  // { success: false } would look to the queue like a job the AI rejected.

  /** App settings — the Metadata page reads `outputDirectory` and `promptSet` from this. */
  async getMetadataSettings(): Promise<any> {
    if (!this.isElectron()) throw new Error('Not running in Electron');
    return this.bridge.getSettings();
  }

  async updateMetadataSettings(settings: any): Promise<any> {
    if (!this.isElectron()) throw new Error('Not running in Electron');
    return this.bridge.updateSettings(settings);
  }

  /** The prompt sets the user can generate against (id / name / platform). */
  async listPromptSets(): Promise<{ success: boolean; promptSets: any[] }> {
    if (!this.isElectron()) throw new Error('Not running in Electron');
    return this.bridge.listPromptSets();
  }

  /** Multi-select file picker for the item list. Distinct from selectFile() above, which is
   *  the workflow's single-file picker and returns a different shape. */
  async selectFiles(): Promise<{ success: boolean; files: string[] }> {
    if (!this.isElectron()) throw new Error('Not running in Electron');
    return this.bridge.selectFiles();
  }

  async selectOutputDirectory(): Promise<{ success: boolean; directory: string | null }> {
    if (!this.isElectron()) throw new Error('Not running in Electron');
    return this.bridge.selectOutputDirectory();
  }

  async isDirectory(filePath: string): Promise<boolean> {
    if (!this.isElectron()) throw new Error('Not running in Electron');
    return this.bridge.isDirectory(filePath);
  }

  /** Existence AND writability, checked before a queue run so a doomed run fails up front. */
  async checkDirectory(dirPath: string): Promise<{ exists: boolean; writable: boolean }> {
    if (!this.isElectron()) throw new Error('Not running in Electron');
    return this.bridge.checkDirectory(dirPath);
  }

  async readDirectory(dirPath: string): Promise<{ success: boolean; directories?: any[]; files?: any[] }> {
    if (!this.isElectron()) throw new Error('Not running in Electron');
    return this.bridge.readDirectory(dirPath);
  }

  async readFile(filePath: string): Promise<string> {
    if (!this.isElectron()) throw new Error('Not running in Electron');
    return this.bridge.readFile(filePath);
  }

  async writeTextFile(filePath: string, content: string): Promise<{ success: boolean; error?: string }> {
    if (!this.isElectron()) throw new Error('Not running in Electron');
    return this.bridge.writeTextFile(filePath, content);
  }

  /** Deletes a path — used by the reports viewer to drop a report's files. */
  async deleteDirectory(dirPath: string): Promise<void> {
    if (!this.isElectron()) throw new Error('Not running in Electron');
    return this.bridge.deleteDirectory(dirPath);
  }

  /**
   * Run one queued job: transcribe every input that needs it, assemble the prompt, send it
   * to the AI, write the report. With `showPrompt` the main process stops after assembling
   * and HOLDS the transcript, resolving { held: true, prompts } — the two-stage
   * "transcribe only" flow, whose second stage is sendHeldPrompt below.
   */
  async generateMetadata(params: {
    inputs: Array<{ path: string; notes?: string }>;
    promptSet: string;
    mode: string;
    jobId?: string;
    jobName?: string;
    chapterFlags?: { [path: string]: boolean };
    showPrompt?: boolean;
  }): Promise<any> {
    if (!this.isElectron()) throw new Error('Not running in Electron');
    return this.bridge.generateMetadata(params);
  }

  /** Stage 2: generate from the transcript the main process is holding — no re-transcribe. */
  async sendHeldPrompt(jobId: string): Promise<any> {
    if (!this.isElectron()) throw new Error('Not running in Electron');
    return this.bridge.sendHeldPrompt(jobId);
  }

  /** Free a held transcript when the user removes the job instead of sending it. */
  async discardHeldPrompt(jobId: string): Promise<any> {
    if (!this.isElectron()) throw new Error('Not running in Electron');
    return this.bridge.discardHeldPrompt(jobId);
  }

  /** Cancel a running metadata job. See preload.ts for why this is not on 'cancel-job'. */
  async cancelMetadataJob(jobId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.isElectron()) throw new Error('Not running in Electron');
    return this.bridge.cancelMetadataJob(jobId);
  }

  /**
   * Transcription/generation progress for the running job. Returns its OWN unsubscribe,
   * which the queue calls the moment a job settles — a stale listener would keep rewriting
   * a finished job's progress from the NEXT job's events.
   *
   * Delivered inside the Angular zone: these events originate in an ipcRenderer callback,
   * and without the hop the progress bars would sit frozen until something else happened
   * to trigger change detection.
   */
  onMetadataProgress(callback: (progress: any) => void): () => void {
    if (!this.isElectron()) return () => {};
    return this.bridge.onMetadataProgress((p: any) => this.ngZone.run(() => callback(p)));
  }

  /**
   * Absolute path of a dropped File. Electron 32 removed `File.path`, so this has to go
   * through the preload's webUtils — reading `(file as any).path` here returns undefined and
   * a drop zone built on it accepts files and adds nothing, with no error anywhere.
   * Returns '' for anything that is not a real file on disk.
   */
  getPathForFile(file: File): string {
    if (!this.isElectron()) return '';
    return this.bridge.getPathForFile(file) || '';
  }

  /**
   * Check if running in Electron
   */
  isElectron(): boolean {
    return !!(window && window.electron);
  }

  /**
   * Get workflow output stream
   */
  getWorkflowOutput(): Observable<{ jobId: string; type: string; data: string }> {
    return this.workflowOutput$.asObservable();
  }

  /**
   * Get workflow complete stream
   */
  getWorkflowComplete(): Observable<{ jobId: string; exitCode: number; result?: any }> {
    return this.workflowComplete$.asObservable();
  }

  // File system operations
  async selectFile(options?: { title?: string; filters?: any[]; properties?: any[] }): Promise<{ canceled: boolean; filePaths: string[] }> {
    if (!this.isElectron()) {
      throw new Error('Not running in Electron');
    }
    return window.electron.selectFile(options);
  }

  async selectDirectory(options?: { title?: string }): Promise<{ canceled: boolean; filePaths: string[] }> {
    if (!this.isElectron()) {
      throw new Error('Not running in Electron');
    }
    return window.electron.selectDirectory(options);
  }

  async browseDirectory(dirPath: string): Promise<any> {
    if (!this.isElectron()) {
      throw new Error('Not running in Electron');
    }
    return window.electron.browseDirectory(dirPath);
  }

  async showInFolder(filePath: string): Promise<any> {
    if (!this.isElectron()) {
      throw new Error('Not running in Electron');
    }
    return window.electron.showInFolder(filePath);
  }

  async openFile(filePath: string): Promise<any> {
    if (!this.isElectron()) {
      throw new Error('Not running in Electron');
    }
    return window.electron.openFile(filePath);
  }

  async checkFileExists(filePath: string): Promise<{ exists: boolean }> {
    if (!this.isElectron()) {
      throw new Error('Not running in Electron');
    }
    return window.electron.checkFileExists(filePath);
  }

  async searchFilesRecursive(options: { rootPath: string; filenames: string[]; maxDepth?: number }): Promise<{ success: boolean; foundFiles?: { [filename: string]: string }; error?: string }> {
    if (!this.isElectron()) {
      throw new Error('Not running in Electron');
    }
    return window.electron.searchFilesRecursive(options);
  }

  async autoDetectAudio(masterVideoPath: string): Promise<{ success: boolean; audioFiles?: { [key: string]: string }; videoFiles?: { [key: string]: string }; error?: string }> {
    if (!this.isElectron()) {
      throw new Error('Not running in Electron');
    }
    return window.electron.autoDetectAudio(masterVideoPath);
  }

  // Dependency checking
  async checkDependencies(): Promise<any> {
    if (!this.isElectron()) {
      throw new Error('Not running in Electron');
    }
    return window.electron.checkDependencies();
  }

  async installPythonPackages(packages: string[]): Promise<{ success: boolean; results?: any; error?: string }> {
    if (!this.isElectron()) {
      throw new Error('Not running in Electron');
    }
    return window.electron.installPythonPackages(packages);
  }

  // Python execution
  async executeWorkflow(options: any): Promise<any> {
    if (!this.isElectron()) {
      throw new Error('Not running in Electron');
    }
    return window.electron.executeWorkflow(options);
  }

  async cancelJob(jobId: string): Promise<any> {
    if (!this.isElectron()) {
      throw new Error('Not running in Electron');
    }
    return window.electron.cancelJob(jobId);
  }

  async sendSkipSignal(): Promise<void> {
    if (!this.isElectron()) {
      throw new Error('Not running in Electron');
    }
    return window.electron.sendSkipSignal();
  }

  // Utility
  async getAppVersion(): Promise<string> {
    if (!this.isElectron()) {
      return 'Web Version';
    }
    return window.electron.getAppVersion();
  }

  async log(level: string, ...args: any[]): Promise<void> {
    if (this.isElectron()) {
      return window.electron.log(level, ...args);
    }
  }

  // Configuration
  async getAssetConfig(): Promise<{ success: boolean; assetPaths?: any; error?: string }> {
    if (!this.isElectron()) {
      throw new Error('Not running in Electron');
    }
    return window.electron.getAssetConfig();
  }

  async saveAssetConfig(assetPaths: any): Promise<{ success: boolean; error?: string }> {
    if (!this.isElectron()) {
      throw new Error('Not running in Electron');
    }
    return window.electron.saveAssetConfig(assetPaths);
  }

  // Audio ducking (Dugan automixer)
  async processAudioDucking(options: {
    tracks: Array<{ type: string; filePath: string }>;
  }): Promise<{ success: boolean; tracks?: Array<{ type: string; filePath: string }>; error?: string }> {
    if (!this.isElectron()) {
      throw new Error('Not running in Electron');
    }
    return window.electron.processAudioDucking(options);
  }

  // Drift correction settings
  async getDriftCorrections(): Promise<any> {
    if (!this.isElectron()) {
      throw new Error('Not running in Electron');
    }
    return window.electron.getDriftCorrections();
  }

  async saveDriftCorrections(config: any): Promise<{ success: boolean; error?: string }> {
    if (!this.isElectron()) {
      throw new Error('Not running in Electron');
    }
    return window.electron.saveDriftCorrections(config);
  }

  // Downloadable assets
  async listAssets(): Promise<{ success: boolean; components?: any[]; error?: string }> {
    if (!this.isElectron()) {
      return { success: true, components: [] };
    }
    return window.electron.listAssets();
  }

  async ensureRequiredAssets(): Promise<{ success: boolean; ok?: boolean; failed?: string[]; error?: string }> {
    if (!this.isElectron()) {
      return { success: true, ok: true, failed: [] };
    }
    return window.electron.ensureRequiredAssets();
  }

  async installAsset(id: string): Promise<{ id: string; ok: boolean; error?: string }> {
    if (!this.isElectron()) {
      throw new Error('Not running in Electron');
    }
    return window.electron.installAsset(id);
  }

  async cancelAsset(id: string): Promise<{ success: boolean }> {
    if (!this.isElectron()) {
      return { success: true };
    }
    return window.electron.cancelAsset(id);
  }

  /** Subscribe to asset download progress (delivered inside the Angular zone). */
  onAssetProgress(callback: (progress: any) => void): void {
    if (this.isElectron()) {
      window.electron.onAssetProgress((p) => this.ngZone.run(() => callback(p)));
    }
  }

  // --- Projects registry bridge ---------------------------------------------
  // Reached through the loose `bridge` cast for the same reason the editor methods are: the
  // ElectronAPI type declaration (src/types/electron.d.ts) is owned elsewhere. Nothing here
  // degrades quietly — outside Electron we throw rather than hand back an empty project list
  // that would look like "you have no projects".

  /**
   * Read the projects list from disk. REJECTS (message names the file) when the registry is
   * corrupt — the caller must surface that and refuse to write, never reset the file.
   */
  async readProjectsRegistry(): Promise<ProjectsRegistry> {
    if (!this.isElectron()) {
      throw new Error('Not running in Electron');
    }
    return this.bridge.readProjectsRegistry();
  }

  /** Atomically replace the projects list on disk. */
  async writeProjectsRegistry(registry: ProjectsRegistry): Promise<{ success: boolean }> {
    if (!this.isElectron()) {
      throw new Error('Not running in Electron');
    }
    return this.bridge.writeProjectsRegistry(registry);
  }

  /** Inspect one project folder: does it exist, and how far along is it? */
  async scanProjectFolder(folderPath: string): Promise<ProjectScanResult> {
    if (!this.isElectron()) {
      throw new Error('Not running in Electron');
    }
    return this.bridge.scanProjectFolder(folderPath);
  }

  removeAssetProgressListener(): void {
    if (this.isElectron()) {
      window.electron.removeAssetProgressListener();
    }
  }
}
