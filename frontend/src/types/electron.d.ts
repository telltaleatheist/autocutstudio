// src/types/electron.d.ts

export interface ElectronAPI {
  selectFile: (options?: { title?: string; filters?: any[] }) => Promise<{ canceled: boolean; filePaths: string[] }>;
  selectDirectory: (options?: { title?: string }) => Promise<{ canceled: boolean; filePaths: string[] }>;
  browseDirectory: (dirPath: string) => Promise<any>;
  showInFolder: (filePath: string) => Promise<any>;
  openFile: (filePath: string) => Promise<any>;
  checkFileExists: (filePath: string) => Promise<{ exists: boolean }>;
  checkDependencies: () => Promise<any>;
  executeWorkflow: (options: any) => Promise<any>;
  cancelJob: (jobId: string) => Promise<any>;
  onWorkflowOutput: (callback: (data: any) => void) => void;
  onWorkflowComplete: (callback: (data: any) => void) => void;
  removeWorkflowListeners: () => void;
  getAppVersion: () => Promise<string>;
  log: (level: string, ...args: any[]) => Promise<void>;
}

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}
