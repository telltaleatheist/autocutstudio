// electron/preload.ts
import { contextBridge, ipcRenderer } from 'electron';

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
  applyAudioDrift: (options: {
    inputPath: string;
    driftFrames: number;
  }) => Promise<{ success: boolean; outputPath?: string; error?: string }>;
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
  exportEditorCuts: (payload: { zipPath: string; cuts: Array<{ startFrame: number; endFrame: number }>; stories?: Array<{ number: number; title: string; regions: Array<{ start: number; end: number }> }>; output?: 'fcpxml' | 'transcripts' }) => Promise<any>;
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
  analyzeStoryChapters: (payload: { segments: Array<{ text: string; startSeconds: number; endSeconds: number }>; model: string; host?: string }) => Promise<{ chapters: Array<{ index: number; startSeconds: number; endSeconds: number; label: string; verbalCue: boolean }> }>;
  suggestStoryTitle: (payload: { text: string; model: string; host?: string }) => Promise<{ title: string }>;

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
  applyAudioDrift: (options) => ipcRenderer.invoke('apply-audio-drift', options),
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
