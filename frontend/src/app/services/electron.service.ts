// src/app/services/electron.service.ts
import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class ElectronService {
  private workflowOutput$ = new Subject<{ jobId: string; type: string; data: string }>();
  private workflowComplete$ = new Subject<{ jobId: string; exitCode: number }>();

  constructor() {
    // Set up event listeners
    if (this.isElectron()) {
      window.electron.onWorkflowOutput((data) => {
        this.workflowOutput$.next(data);
      });

      window.electron.onWorkflowComplete((data) => {
        this.workflowComplete$.next(data);
      });
    }
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
  getWorkflowComplete(): Observable<{ jobId: string; exitCode: number }> {
    return this.workflowComplete$.asObservable();
  }

  // File system operations
  async selectFile(options?: { title?: string; filters?: any[] }): Promise<{ canceled: boolean; filePaths: string[] }> {
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

  async autoDetectAudio(masterVideoPath: string): Promise<{ success: boolean; audioFiles?: { [key: string]: string }; error?: string }> {
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
}
