// electron/preload.ts
import { contextBridge, ipcRenderer, webUtils } from 'electron';

/**
 * Exposed API for renderer process
 */
export interface ElectronAPI {
  // File system operations
  selectFile: (options?: { title?: string; filters?: any[]; properties?: any[] }) => Promise<{ canceled: boolean; filePaths: string[] }>;
  selectDirectory: (options?: { title?: string }) => Promise<{ canceled: boolean; filePaths: string[] }>;
  browseDirectory: (dirPath: string) => Promise<any>;
  showInFolder: (filePath: string) => Promise<any>;
  openFile: (filePath: string) => Promise<any>;
  checkFileExists: (filePath: string) => Promise<{ exists: boolean }>;
  searchFilesRecursive: (options: { rootPath: string; filenames: string[]; maxDepth?: number }) => Promise<{ success: boolean; foundFiles?: { [filename: string]: string }; error?: string }>;
  autoDetectAudio: (masterVideoPath: string) => Promise<{ success: boolean; audioFiles?: { [key: string]: string }; error?: string }>;

  // Dependency checking
  checkDependencies: () => Promise<any>;
  installPythonPackages: (packages: string[]) => Promise<{ success: boolean; results?: any; error?: string }>;

  // Python execution
  executeWorkflow: (options: any) => Promise<any>;
  measureAlignment: (options: any) => Promise<{ success: boolean; sources?: { audio: any; video: any }; error?: string }>;
  cancelJob: (jobId: string) => Promise<any>;
  sendSkipSignal: () => Promise<void>;

  // Audio processing
  processAudioDucking: (options: {
    tracks: Array<{ type: string; filePath: string }>;
  }) => Promise<{ success: boolean; tracks?: Array<{ type: string; filePath: string }>; error?: string }>;

  // Workflow events
  onWorkflowOutput: (callback: (data: any) => void) => void;
  onWorkflowComplete: (callback: (data: any) => void) => void;
  removeWorkflowListeners: () => void;
  onDependencyStatus: (callback: (status: any) => void) => void;

  // Manual-alignment wizard
  openAlignment: (payload: any) => Promise<{ success: boolean; error?: string }>;
  getAlignmentPayload: () => Promise<{ success: boolean; payload?: any }>;
  completeAlignment: (overrides: any) => Promise<{ success: boolean }>;
  cancelAlignment: () => Promise<{ success: boolean }>;
  alignmentScanActivity: (filePath: string) => Promise<{ success: boolean; durationSec?: number; firstSustainedSec?: number; lastSustainedSec?: number; error?: string }>;
  alignmentExtractPeaks: (opts: { filePath: string; startSec: number; durationSec: number; buckets: number }) => Promise<{ success: boolean; min?: number[]; max?: number[]; buckets?: number; error?: string }>;
  alignmentExtractSamples: (opts: { filePath: string; startSec: number; durationSec: number; sampleRate: number }) => Promise<{ success: boolean; sampleRate?: number; samples?: Float32Array; error?: string }>;
  onAlignmentPayload: (callback: (payload: any) => void) => void;
  onAlignmentComplete: (callback: (data: any) => void) => void;
  onAlignmentCancelled: (callback: (data: any) => void) => void;
  removeAlignmentListeners: () => void;

  // View-only timeline editor
  openEditor: (payload: { zipPath: string }) => Promise<{ success: boolean; error?: string }>;
  getEditorPayload: () => Promise<{ zipPath: string }>;
  getEditorManifest: (zipPath: string) => Promise<any>;
  // `sequence` is the playback ORDER as a partition of the SURVIVORS (the complement of `cuts`),
  // ORIGINAL seconds, frame-aligned; absent means source order.
  exportEditorCuts: (payload: { zipPath: string; cuts: Array<{ startFrame: number; endFrame: number }>; sequence?: Array<{ start: number; end: number }>; stories?: Array<{ number: number; title: string; regions: Array<{ start: number; end: number }> }>; output?: 'fcpxml' | 'transcripts' }) => Promise<any>;
  loadEditorEdits: (payload: { zipPath: string }) => Promise<any | null>;
  saveEditorEdits: (payload: { zipPath: string; edits: any }) => Promise<{ path: string }>;
  onEditorPayload: (callback: (payload: any) => void) => void;
  removeEditorListeners: () => void;

  // Transcription (Whisper per source track)
  transcribeSession: (payload: { zipPath: string }) => Promise<{ jobId: string }>;
  cancelTranscription: (payload: { jobId: string }) => Promise<{ success: boolean }>;
  loadTranscript: (payload: { zipPath: string }) => Promise<any>;
  onTranscribeProgress: (callback: (data: any) => void) => void;
  onTranscribeComplete: (callback: (data: any) => void) => void;
  removeTranscribeListeners: () => void;

  // Story analysis (local Ollama LLM)
  ollamaListModels: (payload?: { host?: string }) => Promise<{ connected: boolean; models: Array<{ id: string; name: string }> }>;
  // `consolidate: false` says "this span is already ONE story" — it skips the stage that decides
  // where one story ends and the next begins, which inside a declared story can only merge real
  // chapters away. See AnalyzeOptions in services/chapter-splitter.ts.
  // The handler forwards it verbatim; the default (true) lives in chapter-splitter alone.
  // `startApprox` on a chapter: its start is a raw ±45 s junction, not a mapped quote. It rides
  // out on the payload because the degradation is invisible downstream — a description built from
  // approximate starts reads exactly like a good one. No handler change needed; the handler
  // returns whatever analyzeChapters produced.
  analyzeStoryChapters: (payload: { segments: Array<{ text: string; startSeconds: number; endSeconds: number; speaker: 'host' | 'clip' }>; model: string; host?: string; consolidate?: boolean }) => Promise<{ chapters: Array<{ index: number; startSeconds: number; endSeconds: number; label: string; verbalCue: boolean; startApprox?: boolean; subChapters: Array<{ startSeconds: number; endSeconds: number; label: string; startApprox?: boolean }> }> }>;
  // `text` takes a SUBJECT LIST (a story's chapter labels, in order) as well as transcript text —
  // suggestTitle() picks its prompt from the shape. The array is what the fine-tuned titling
  // adapter conditions on, so it is the preferred shape, not a convenience.
  suggestStoryTitle: (payload: { text: string | string[]; model: string; host?: string }) => Promise<{ title: string }>;
  cancelStoryAnalysis: () => Promise<{ stopped: boolean }>;
  unloadStoryModel: (payload: { model: string; host?: string }) => Promise<{ ok: boolean }>;
  onStoryAnalyzeProgress: (callback: (p: { phase: string; done: number; total: number }) => void) => void;
  removeStoryAnalyzeProgressListener: () => void;

  // Titles tab (local fine-tuned title model via Ollama)
  generateTitles: (payload: {
    text: string;
    format: 'normal' | 'livestream';
    target: 'top-decile' | 'strong' | 'typical' | 'weak';
    count?: number;
    model?: string;
    host?: string;
  }) => Promise<{ titles: string[]; subjects: string[]; model: string }>;
  cancelTitles: () => Promise<{ stopped: boolean }>;
  unloadTitleModel: (payload?: { model?: string; host?: string }) => Promise<{ ok: boolean }>;
  /**
   * Persist one finished titling run into the metadata report store, so the Reports page
   * lists it. The shape is the store's — `items[]`, `_title`, `titles[]` — because the
   * Reports page reads it unchanged; see services/metadata/title-report.service.ts, whose
   * TitleReport this MIRRORS (it cannot be imported: the preload tsconfig compiles this file
   * alone). `saved: false` means no output directory was configured, which is not an error:
   * the titles are on screen either way.
   */
  saveTitleReport: (report: {
    job_id: string;
    job_name: string;
    created_at: string;
    txt_folder: string;
    txt_files: string[];
    status: string;
    kind: 'story-titles';
    generator: string;
    items: Array<{
      _title: string;
      titles: string[];
      generator: string;
      kind: 'story-titles';
      model: string;
      format: 'normal' | 'livestream';
      target: string;
      subjects: string[];
      titleBand: { min: number; max: number };
      outOfBand: number[];
      generatedAt: string;
      /** The video's chapter list, story-relative — the Reports viewer's chapters shape. */
      chapters?: Array<{ timestamp: string; title: string; sequence: number }>;
    }>;
  }) => Promise<{ saved: true; path: string } | { saved: false; reason: string }>;
  onTitlesProgress: (callback: (p: { done: number; total: number; title?: string }) => void) => void;
  removeTitlesProgressListener: () => void;
  // Editor → Titles handoff (cross-window): the editor pushes, the main window receives.
  // A BATCH of handoffs, one per story — the editor can send several picked stories at once,
  // and each is its own upload with its own subject list. Both the push and the pull carry the
  // main process's whole undelivered queue; an empty array from the pull means nothing waited.
  // `chapters` (optional) is the story's chapter list with times relative to that story's own
  // exported video. It travels for the SAVED REPORT only — the titling model's input is the
  // subject lines and nothing else, and no timestamp is ever added to them.
  sendSubjectsToTitles: (payload: { handoffs: { subjects: string[]; format?: 'normal' | 'livestream'; source?: string; chapters?: { timestamp: string; title: string }[] }[] }) => Promise<{ success: boolean }>;
  takePendingTitleSubjects: () => Promise<{ subjects: string[]; format: 'normal' | 'livestream'; source?: string; chapters?: { timestamp: string; title: string }[] }[]>;
  onTitlesSubjects: (callback: (p: { subjects: string[]; format: 'normal' | 'livestream'; source?: string; chapters?: { timestamp: string; title: string }[] }[]) => void) => void;
  removeTitlesSubjectsListener: () => void;

  // Metadata page (ported from ContentStudio — channel names and payload shapes are that
  // app's, verbatim, because the main-process half is the same code ported alongside this).
  // ONE forced rename: ContentStudio cancels a metadata job on 'cancel-job', which this app
  // already owns for Python workflow jobs. Registering it twice makes ipcMain THROW at
  // startup, so the metadata cancel lives on 'metadata:cancel-job'.
  getSettings: () => Promise<any>;
  updateSettings: (settings: any) => Promise<any>;
  listPromptSets: () => Promise<{ success: boolean; promptSets: any[] }>;
  selectFiles: () => Promise<{ success: boolean; files: string[] }>;
  selectOutputDirectory: () => Promise<{ success: boolean; directory: string | null }>;
  isDirectory: (filePath: string) => Promise<boolean>;
  checkDirectory: (dirPath: string) => Promise<{ exists: boolean; writable: boolean }>;
  readDirectory: (dirPath: string) => Promise<{ success: boolean; directories?: any[]; files?: any[] }>;
  readFile: (filePath: string) => Promise<string>;
  writeTextFile: (filePath: string, content: string) => Promise<{ success: boolean; error?: string }>;
  deleteDirectory: (dirPath: string) => Promise<void>;
  generateMetadata: (params: any) => Promise<any>;
  sendHeldPrompt: (jobId: string) => Promise<any>;
  discardHeldPrompt: (jobId: string) => Promise<any>;
  cancelMetadataJob: (jobId: string) => Promise<{ success: boolean; error?: string }>;
  /** Returns its OWN unsubscribe. A job registers a listener for its run and drops it when
   *  it finishes; a shared removeAllListeners() would tear down the next job's listener too. */
  onMetadataProgress: (callback: (progress: any) => void) => () => void;
  /**
   * Absolute path of a File from a drag-and-drop. Electron 32 REMOVED `File.path`, so the
   * renderer cannot read it itself — a drop zone written the old way silently adds nothing.
   * Returns '' when the object is not a real filesystem file.
   */
  getPathForFile: (file: File) => string;

  // Utility
  getAppVersion: () => Promise<string>;
  log: (level: string, ...args: any[]) => Promise<void>;

  // Configuration
  getAssetConfig: () => Promise<{ success: boolean; assetPaths?: any; error?: string }>;
  saveAssetConfig: (assetPaths: any) => Promise<{ success: boolean; error?: string }>;
  getDriftCorrections: () => Promise<any>;
  saveDriftCorrections: (config: any) => Promise<{ success: boolean; error?: string }>;

  // Downloadable assets (ffmpeg/ffprobe, Python env, models)
  listAssets: () => Promise<{ success: boolean; components?: any[]; error?: string }>;
  installAsset: (id: string) => Promise<{ id: string; ok: boolean; error?: string }>;
  cancelAsset: (id: string) => Promise<{ success: boolean }>;
  ensureRequiredAssets: () => Promise<{ success: boolean; ok?: boolean; failed?: string[]; error?: string }>;
  onAssetProgress: (callback: (progress: any) => void) => void;
  removeAssetProgressListener: () => void;
}

// Expose API to renderer
const electronAPI: ElectronAPI = {
  // File system
  selectFile: (options) => ipcRenderer.invoke('select-file', options),
  selectDirectory: (options) => ipcRenderer.invoke('select-directory', options),
  browseDirectory: (dirPath) => ipcRenderer.invoke('browse-directory', dirPath),
  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  checkFileExists: (filePath) => ipcRenderer.invoke('check-file-exists', filePath),
  searchFilesRecursive: (options) => ipcRenderer.invoke('search-files-recursive', options),
  autoDetectAudio: (masterVideoPath) => ipcRenderer.invoke('auto-detect-audio', masterVideoPath),

  // Dependencies
  checkDependencies: () => ipcRenderer.invoke('check-dependencies'),
  installPythonPackages: (packages) => ipcRenderer.invoke('install-python-packages', packages),

  // Python execution
  executeWorkflow: (options) => ipcRenderer.invoke('execute-workflow', options),
  measureAlignment: (options) => ipcRenderer.invoke('alignment:measure', options),
  cancelJob: (jobId) => ipcRenderer.invoke('cancel-job', jobId),
  sendSkipSignal: () => ipcRenderer.invoke('send-skip-signal'),

  // Audio processing
  processAudioDucking: (options) => ipcRenderer.invoke('process-audio-ducking', options),

  // Workflow events
  onWorkflowOutput: (callback) => {
    ipcRenderer.on('workflow-output', (event, data) => callback(data));
  },
  onWorkflowComplete: (callback) => {
    ipcRenderer.on('workflow-complete', (event, data) => callback(data));
  },
  removeWorkflowListeners: () => {
    ipcRenderer.removeAllListeners('workflow-output');
    ipcRenderer.removeAllListeners('workflow-complete');
  },
  onDependencyStatus: (callback) => {
    ipcRenderer.on('dependency-status', (event, status) => callback(status));
  },

  // Manual-alignment wizard
  openAlignment: (payload) => ipcRenderer.invoke('alignment:open', payload),
  getAlignmentPayload: () => ipcRenderer.invoke('alignment:get-payload'),
  completeAlignment: (overrides) => ipcRenderer.invoke('alignment:complete', overrides),
  cancelAlignment: () => ipcRenderer.invoke('alignment:cancel'),
  alignmentScanActivity: (filePath) => ipcRenderer.invoke('alignment:scan-activity', filePath),
  alignmentExtractPeaks: (opts) => ipcRenderer.invoke('alignment:extract-peaks', opts),
  alignmentExtractSamples: (opts) => ipcRenderer.invoke('alignment:extract-samples', opts),
  onAlignmentPayload: (callback) => {
    ipcRenderer.on('alignment-payload', (_event, payload) => callback(payload));
  },
  onAlignmentComplete: (callback) => {
    ipcRenderer.on('alignment-complete', (_event, data) => callback(data));
  },
  onAlignmentCancelled: (callback) => {
    ipcRenderer.on('alignment-cancelled', (_event, data) => callback(data));
  },
  removeAlignmentListeners: () => {
    ipcRenderer.removeAllListeners('alignment-payload');
    ipcRenderer.removeAllListeners('alignment-complete');
    ipcRenderer.removeAllListeners('alignment-cancelled');
  },

  // View-only timeline editor
  openEditor: (payload) => ipcRenderer.invoke('editor:open', payload),
  getEditorPayload: () => ipcRenderer.invoke('editor:get-payload'),
  getEditorManifest: (zipPath) => ipcRenderer.invoke('editor:manifest', { zipPath }),
  exportEditorCuts: (payload) => ipcRenderer.invoke('editor:export', payload),
  loadEditorEdits: (payload) => ipcRenderer.invoke('editor:load-edits', payload),
  saveEditorEdits: (payload) => ipcRenderer.invoke('editor:save-edits', payload),
  onEditorPayload: (callback) => {
    ipcRenderer.on('editor-payload', (_event, payload) => callback(payload));
  },
  removeEditorListeners: () => {
    ipcRenderer.removeAllListeners('editor-payload');
  },

  // Transcription (Whisper per source track)
  transcribeSession: (payload) => ipcRenderer.invoke('editor:transcribe', payload),
  cancelTranscription: (payload) => ipcRenderer.invoke('editor:transcribe-cancel', payload),
  loadTranscript: (payload) => ipcRenderer.invoke('editor:transcript-load', payload),
  onTranscribeProgress: (callback) => {
    ipcRenderer.on('transcribe-progress', (_event, data) => callback(data));
  },
  onTranscribeComplete: (callback) => {
    ipcRenderer.on('transcribe-complete', (_event, data) => callback(data));
  },
  removeTranscribeListeners: () => {
    ipcRenderer.removeAllListeners('transcribe-progress');
    ipcRenderer.removeAllListeners('transcribe-complete');
  },

  // Story analysis (local Ollama LLM)
  ollamaListModels: (payload) => ipcRenderer.invoke('ollama:list-models', payload),
  analyzeStoryChapters: (payload) => ipcRenderer.invoke('story:analyze-chapters', payload),
  suggestStoryTitle: (payload) => ipcRenderer.invoke('story:suggest-title', payload),
  cancelStoryAnalysis: () => ipcRenderer.invoke('story:cancel'),
  unloadStoryModel: (payload) => ipcRenderer.invoke('story:unload-model', payload),
  onStoryAnalyzeProgress: (callback) => {
    ipcRenderer.on('story:analyze-progress', (_event, p) => callback(p));
  },
  removeStoryAnalyzeProgressListener: () => {
    ipcRenderer.removeAllListeners('story:analyze-progress');
  },

  // Titles tab (local fine-tuned title model via Ollama)
  generateTitles: (payload) => ipcRenderer.invoke('titles:generate', payload),
  cancelTitles: () => ipcRenderer.invoke('titles:cancel'),
  unloadTitleModel: (payload) => ipcRenderer.invoke('titles:unload', payload),
  saveTitleReport: (report) => ipcRenderer.invoke('titles:save-report', report),
  onTitlesProgress: (callback) => {
    ipcRenderer.on('titles:progress', (_event, p) => callback(p));
  },
  removeTitlesProgressListener: () => {
    ipcRenderer.removeAllListeners('titles:progress');
  },
  sendSubjectsToTitles: (payload) => ipcRenderer.invoke('titles:send-subjects', payload),
  takePendingTitleSubjects: () => ipcRenderer.invoke('titles:take-pending'),
  onTitlesSubjects: (callback) => {
    ipcRenderer.on('titles:subjects', (_event, p) => callback(p));
  },
  removeTitlesSubjectsListener: () => {
    ipcRenderer.removeAllListeners('titles:subjects');
  },

  // Metadata page. Channel names are ContentStudio's, unchanged — see the interface note
  // above for the single 'cancel-job' → 'metadata:cancel-job' rename and why it is forced.
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (settings) => ipcRenderer.invoke('update-settings', settings),
  listPromptSets: () => ipcRenderer.invoke('list-prompt-sets'),
  selectFiles: () => ipcRenderer.invoke('select-files'),
  selectOutputDirectory: () => ipcRenderer.invoke('select-output-directory'),
  isDirectory: (filePath) => ipcRenderer.invoke('is-directory', filePath),
  checkDirectory: (dirPath) => ipcRenderer.invoke('check-directory', dirPath),
  readDirectory: (dirPath) => ipcRenderer.invoke('read-directory', dirPath),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  writeTextFile: (filePath, content) => ipcRenderer.invoke('write-text-file', filePath, content),
  deleteDirectory: (dirPath) => ipcRenderer.invoke('delete-directory', dirPath),
  generateMetadata: (params) => ipcRenderer.invoke('generate-metadata', params),
  sendHeldPrompt: (jobId) => ipcRenderer.invoke('send-held-prompt', { jobId }),
  discardHeldPrompt: (jobId) => ipcRenderer.invoke('discard-held-prompt', { jobId }),
  cancelMetadataJob: (jobId) => ipcRenderer.invoke('metadata:cancel-job', jobId),
  onMetadataProgress: (callback) => {
    const listener = (_event: any, progress: any) => callback(progress);
    ipcRenderer.on('generation-progress', listener);
    return () => ipcRenderer.removeListener('generation-progress', listener);
  },
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      // Not a filesystem file (a dragged selection, a browser-synthesised blob). The caller
      // reports the file by name rather than adding an item that points nowhere.
      return '';
    }
  },

  // Utility
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  log: (level, ...args) => ipcRenderer.invoke('log', level, ...args),

  // Configuration
  getAssetConfig: () => ipcRenderer.invoke('get-asset-config'),
  saveAssetConfig: (assetPaths) => ipcRenderer.invoke('save-asset-config', assetPaths),
  getDriftCorrections: () => ipcRenderer.invoke('get-drift-corrections'),
  saveDriftCorrections: (config) => ipcRenderer.invoke('save-drift-corrections', config),

  // Downloadable assets
  listAssets: () => ipcRenderer.invoke('assets:list'),
  installAsset: (id) => ipcRenderer.invoke('assets:install', id),
  cancelAsset: (id) => ipcRenderer.invoke('assets:cancel', id),
  ensureRequiredAssets: () => ipcRenderer.invoke('assets:ensure-required'),
  onAssetProgress: (callback) => {
    ipcRenderer.on('asset-progress', (_event, progress) => callback(progress));
  },
  removeAssetProgressListener: () => {
    ipcRenderer.removeAllListeners('asset-progress');
  }
};

contextBridge.exposeInMainWorld('electron', electronAPI);

// TypeScript declarations for window object
declare global {
  interface Window {
    electron: ElectronAPI;
  }
}
