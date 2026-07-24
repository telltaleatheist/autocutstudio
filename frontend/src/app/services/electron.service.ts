// src/app/services/electron.service.ts
import { Injectable, NgZone } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { EditorManifest } from '../models/editor-manifest';

@Injectable({
  providedIn: 'root'
})
export class ElectronService {
  private workflowOutput$ = new Subject<{ jobId: string; type: string; data: string }>();
  private workflowComplete$ = new Subject<{ jobId: string; exitCode: number; result?: any }>();
  // Manual-alignment wizard results relayed from the second window (main-window side).
  private alignmentComplete$ = new Subject<{ overrides: any }>();
  private alignmentCancelled$ = new Subject<{ reason?: string }>();

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

  /** Open (or focus) the editor window on a session's compounds zip. */
  async openEditor(payload: { zipPath: string }): Promise<{ success: boolean; error?: string }> {
    if (!this.isElectron()) {
      throw new Error('Not running in Electron');
    }
    return this.bridge.openEditor(payload);
  }

  /** (Editor window) Pull the zip path this window was opened with. */
  async getEditorPayload(): Promise<{ zipPath: string }> {
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
    stories?: Array<{ number: number; title: string; regions: Array<{ start: number; end: number }> }>;
    output?: 'fcpxml' | 'transcripts';
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

  /** Split a span of transcript segments into consecutive subject chapters. */
  async analyzeStoryChapters(payload: {
    segments: Array<{ text: string; startSeconds: number; endSeconds: number }>;
    model: string;
    host?: string;
  }): Promise<{ chapters: Array<{ index: number; startSeconds: number; endSeconds: number; label: string; verbalCue: boolean }> }> {
    if (!this.isElectron()) throw new Error('Not running in Electron');
    return this.bridge.analyzeStoryChapters(payload);
  }

  /** Suggest a single title for a story's transcript text. */
  async suggestStoryTitle(payload: { text: string; model: string; host?: string }): Promise<{ title: string }> {
    if (!this.isElectron()) throw new Error('Not running in Electron');
    return this.bridge.suggestStoryTitle(payload);
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

  // Audio drift correction
  async applyAudioDrift(options: {
    inputPath: string;
    driftFrames: number;
  }): Promise<{ success: boolean; outputPath?: string; error?: string }> {
    if (!this.isElectron()) {
      throw new Error('Not running in Electron');
    }
    return window.electron.applyAudioDrift(options);
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

  removeAssetProgressListener(): void {
    if (this.isElectron()) {
      window.electron.removeAssetProgressListener();
    }
  }
}
