// electron/preload.ts
import { contextBridge, ipcRenderer } from 'electron';

/**
 * Exposed API for renderer process
 */
export interface ElectronAPI {
  // File system operations
  selectFile: (options?: { title?: string; filters?: any[] }) => Promise<{ canceled: boolean; filePaths: string[] }>;
  selectDirectory: (options?: { title?: string }) => Promise<{ canceled: boolean; filePaths: string[] }>;
  browseDirectory: (dirPath: string) => Promise<any>;
  showInFolder: (filePath: string) => Promise<any>;
  openFile: (filePath: string) => Promise<any>;
  checkFileExists: (filePath: string) => Promise<{ exists: boolean }>;
  autoDetectAudio: (masterVideoPath: string) => Promise<{ success: boolean; audioFiles?: { [key: string]: string }; error?: string }>;

  // Dependency checking
  checkDependencies: () => Promise<any>;

  // Python execution
  executeWorkflow: (options: any) => Promise<any>;
  cancelJob: (jobId: string) => Promise<any>;

  // Audio processing
  applyAudioDrift: (options: {
    inputPath: string;
    driftFrames: number;
    videoDuration: number;
    fps: number;
  }) => Promise<{ success: boolean; outputPath?: string; error?: string }>;

  // Workflow events
  onWorkflowOutput: (callback: (data: any) => void) => void;
  onWorkflowComplete: (callback: (data: any) => void) => void;
  removeWorkflowListeners: () => void;

  // Utility
  getAppVersion: () => Promise<string>;
  log: (level: string, ...args: any[]) => Promise<void>;

  // Configuration
  getAssetConfig: () => Promise<{ success: boolean; assetPaths?: any; error?: string }>;
  saveAssetConfig: (assetPaths: any) => Promise<{ success: boolean; error?: string }>;
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
  autoDetectAudio: (masterVideoPath) => ipcRenderer.invoke('auto-detect-audio', masterVideoPath),

  // Dependencies
  checkDependencies: () => ipcRenderer.invoke('check-dependencies'),

  // Python execution
  executeWorkflow: (options) => ipcRenderer.invoke('execute-workflow', options),
  cancelJob: (jobId) => ipcRenderer.invoke('cancel-job', jobId),

  // Audio processing
  applyAudioDrift: (options) => ipcRenderer.invoke('apply-audio-drift', options),

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

  // Utility
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  log: (level, ...args) => ipcRenderer.invoke('log', level, ...args),

  // Configuration
  getAssetConfig: () => ipcRenderer.invoke('get-asset-config'),
  saveAssetConfig: (assetPaths) => ipcRenderer.invoke('save-asset-config', assetPaths)
};

contextBridge.exposeInMainWorld('electron', electronAPI);

// TypeScript declarations for window object
declare global {
  interface Window {
    electron: ElectronAPI;
  }
}
