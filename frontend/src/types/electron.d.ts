// src/types/electron.d.ts

export interface ElectronAPI {
  selectFile: (options?: { title?: string; filters?: any[] }) => Promise<{ canceled: boolean; filePaths: string[] }>;
  selectDirectory: (options?: { title?: string }) => Promise<{ canceled: boolean; filePaths: string[] }>;
  browseDirectory: (dirPath: string) => Promise<any>;
  showInFolder: (filePath: string) => Promise<any>;
  openFile: (filePath: string) => Promise<any>;
  checkFileExists: (filePath: string) => Promise<{ exists: boolean }>;
  searchFilesRecursive: (options: { rootPath: string; filenames: string[]; maxDepth?: number }) => Promise<{ success: boolean; foundFiles?: { [filename: string]: string }; error?: string }>;
  autoDetectAudio: (masterVideoPath: string) => Promise<{ success: boolean; audioFiles?: { [key: string]: string }; error?: string }>;
  checkDependencies: () => Promise<any>;
  installPythonPackages: (packages: string[]) => Promise<{ success: boolean; results?: any; error?: string }>;
  onDependencyStatus: (callback: (status: any) => void) => void;
  executeWorkflow: (options: any) => Promise<any>;
  measureAlignment: (options: any) => Promise<{ success: boolean; sources?: { audio: any; video: any }; error?: string }>;
  cancelJob: (jobId: string) => Promise<any>;
  sendSkipSignal: () => Promise<void>;

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

  // Timeline editor: export a cut list to a revised master-hybrid FCPXML (preload bridge).
  exportEditorCuts: (payload: { zipPath: string; cuts: Array<{ startFrame: number; endFrame: number }>; stories?: Array<{ number: number; title: string; regions: Array<{ start: number; end: number }> }>; output?: 'fcpxml' | 'transcripts' }) => Promise<any>;
  loadEditorEdits: (payload: { zipPath: string }) => Promise<any | null>;
  saveEditorEdits: (payload: { zipPath: string; edits: any }) => Promise<{ path: string }>;

  // Timeline editor: per-track Whisper transcription (preload bridge).
  transcribeSession: (payload: { zipPath: string }) => Promise<{ jobId: string }>;
  cancelTranscription: (payload: { jobId: string }) => Promise<any>;
  loadTranscript: (payload: { zipPath: string }) => Promise<TranscriptSidecar | null>;
  onTranscribeProgress: (callback: (data: { jobId: string; progress: number; message: string }) => void) => void;
  onTranscribeComplete: (callback: (data: { jobId: string; exitCode: number; result: any; errorMessage?: string }) => void) => void;
  removeTranscribeListeners: () => void;
  applyAudioDrift: (options: {
    inputPath: string;
    driftFrames: number;
  }) => Promise<{ success: boolean; outputPath?: string; error?: string }>;
  processAudioDucking: (options: {
    tracks: Array<{ type: string; filePath: string }>;
  }) => Promise<{ success: boolean; tracks?: Array<{ type: string; filePath: string }>; error?: string }>;
  onWorkflowOutput: (callback: (data: any) => void) => void;
  onWorkflowComplete: (callback: (data: any) => void) => void;
  removeWorkflowListeners: () => void;
  getAppVersion: () => Promise<string>;
  log: (level: string, ...args: any[]) => Promise<void>;
  getAssetConfig: () => Promise<{ success: boolean; assetPaths?: any; error?: string }>;
  saveAssetConfig: (assetPaths: any) => Promise<{ success: boolean; error?: string }>;
  getDriftCorrections: () => Promise<any>;
  saveDriftCorrections: (config: any) => Promise<{ success: boolean; error?: string }>;

  // Downloadable assets (ffmpeg/ffprobe, Python env, models)
  listAssets: () => Promise<{ success: boolean; components?: AssetComponentStatus[]; error?: string }>;
  installAsset: (id: string) => Promise<{ id: string; ok: boolean; error?: string }>;
  cancelAsset: (id: string) => Promise<{ success: boolean }>;
  ensureRequiredAssets: () => Promise<{ success: boolean; ok?: boolean; failed?: string[]; error?: string }>;
  onAssetProgress: (callback: (progress: AssetProgress) => void) => void;
  removeAssetProgressListener: () => void;
}

export interface AssetComponentStatus {
  id: string;
  name: string;
  description: string;
  required: boolean;
  state: 'installed' | 'available' | 'installing' | 'error';
  installable: boolean;
  sizeBytes: number;
  version?: string;
}

export interface TranscriptSidecar {
  schemaVersion: number;
  session: string;
  model: string;
  calibration: string;
  frameSeconds: number;
  tracks: Array<{ id: string; label: string; file: string }>;
  words: Array<{
    track: string;
    text: string;
    timelineStart: number;
    timelineEnd: number;
    fileStart: number;
    fileEnd: number;
    group: number;
    prob?: number;
  }>;
}

export interface AssetProgress {
  id: string;
  phase: 'resolve' | 'download' | 'verify' | 'extract' | 'postinstall' | 'done' | 'error';
  pct: number;
  receivedBytes?: number;
  totalBytes?: number;
  message?: string;
}

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}
