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
  cancelJob: (jobId: string) => Promise<any>;
  sendSkipSignal: () => Promise<void>;
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
