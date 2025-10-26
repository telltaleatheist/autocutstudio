// src/types/electron.d.ts

export interface ElectronAPI {
  selectFile: (options?: { title?: string; filters?: any[] }) => Promise<{ canceled: boolean; filePaths: string[] }>;
  selectDirectory: (options?: { title?: string }) => Promise<{ canceled: boolean; filePaths: string[] }>;
  browseDirectory: (dirPath: string) => Promise<any>;
  showInFolder: (filePath: string) => Promise<any>;
  openFile: (filePath: string) => Promise<any>;
  checkFileExists: (filePath: string) => Promise<{ exists: boolean }>;
  autoDetectAudio: (masterVideoPath: string) => Promise<{ success: boolean; audioFiles?: { [key: string]: string }; error?: string }>;
  checkDependencies: () => Promise<any>;
  executeWorkflow: (options: any) => Promise<any>;
  cancelJob: (jobId: string) => Promise<any>;
  sendSkipSignal: () => Promise<void>;
  applyAudioDrift: (options: {
    inputPath: string;
    driftFrames: number;
  }) => Promise<{ success: boolean; outputPath?: string; error?: string }>;
  processAudioDucking: (options: {
    audio1: string;
    audio2: string;
    mode: 'duck1' | 'duck2' | 'mutual';
    threshold: number;
  }) => Promise<{ success: boolean; outputFiles?: string[]; error?: string }>;
  onWorkflowOutput: (callback: (data: any) => void) => void;
  onWorkflowComplete: (callback: (data: any) => void) => void;
  removeWorkflowListeners: () => void;
  getAppVersion: () => Promise<string>;
  log: (level: string, ...args: any[]) => Promise<void>;
  getAssetConfig: () => Promise<{ success: boolean; assetPaths?: any; error?: string }>;
  saveAssetConfig: (assetPaths: any) => Promise<{ success: boolean; error?: string }>;
}

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}
