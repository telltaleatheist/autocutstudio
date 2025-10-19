// src/app/services/processing.service.ts
import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { ElectronService } from './electron.service';

export interface ProcessingJob {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  progress: number;
  message: string;
  output: string[];
  error?: string;
  results?: any[];
  startTime?: Date;
  endTime?: Date;
}

@Injectable({
  providedIn: 'root'
})
export class ProcessingService {
  private currentJob$ = new BehaviorSubject<ProcessingJob | null>(null);
  private jobHistory$ = new BehaviorSubject<ProcessingJob[]>([]);

  constructor(private electronService: ElectronService) {
    // Listen for workflow output
    this.electronService.getWorkflowOutput().subscribe((data) => {
      this.handleWorkflowOutput(data);
    });

    // Listen for workflow completion
    this.electronService.getWorkflowComplete().subscribe((data) => {
      this.handleWorkflowComplete(data);
    });
  }

  /**
   * Get current job observable
   */
  getCurrentJob(): Observable<ProcessingJob | null> {
    return this.currentJob$.asObservable();
  }

  /**
   * Get job history observable
   */
  getJobHistory(): Observable<ProcessingJob[]> {
    return this.jobHistory$.asObservable();
  }

  /**
   * Start a new workflow
   */
  async startWorkflow(options: any): Promise<void> {
    try {
      const result = await this.electronService.executeWorkflow(options);

      if (result.success) {
        const job: ProcessingJob = {
          id: result.jobId,
          status: 'running',
          progress: 0,
          message: 'Starting workflow...',
          output: [],
          startTime: new Date()
        };

        this.currentJob$.next(job);
      } else {
        throw new Error(result.error || 'Failed to start workflow');
      }
    } catch (error: any) {
      console.error('Error starting workflow:', error);
      throw error;
    }
  }

  /**
   * Cancel current job
   */
  async cancelJob(): Promise<void> {
    const currentJob = this.currentJob$.value;
    if (!currentJob) return;

    try {
      await this.electronService.cancelJob(currentJob.id);

      const updatedJob = {
        ...currentJob,
        status: 'error' as const,
        message: 'Job canceled by user',
        error: 'Canceled',
        endTime: new Date()
      };

      this.currentJob$.next(updatedJob);
      this.addToHistory(updatedJob);
    } catch (error: any) {
      console.error('Error canceling job:', error);
    }
  }

  /**
   * Handle workflow output
   */
  private handleWorkflowOutput(data: { jobId: string; type: string; data: string }): void {
    const currentJob = this.currentJob$.value;
    if (!currentJob || currentJob.id !== data.jobId) return;

    const output = [...currentJob.output, data.data];
    const updatedJob = {
      ...currentJob,
      output,
      message: this.extractLastMessage(output)
    };

    this.currentJob$.next(updatedJob);
  }

  /**
   * Handle workflow completion
   */
  private handleWorkflowComplete(data: { jobId: string; exitCode: number }): void {
    const currentJob = this.currentJob$.value;
    if (!currentJob || currentJob.id !== data.jobId) return;

    const updatedJob = {
      ...currentJob,
      status: data.exitCode === 0 ? 'completed' as const : 'error' as const,
      progress: 100,
      message: data.exitCode === 0 ? 'Workflow completed successfully!' : 'Workflow failed',
      error: data.exitCode !== 0 ? `Process exited with code ${data.exitCode}` : undefined,
      endTime: new Date()
    };

    this.currentJob$.next(updatedJob);
    this.addToHistory(updatedJob);
  }

  /**
   * Extract last meaningful message from output
   */
  private extractLastMessage(output: string[]): string {
    const lines = output.join('').split('\n').filter(line => line.trim());
    return lines[lines.length - 1] || 'Processing...';
  }

  /**
   * Add job to history
   */
  private addToHistory(job: ProcessingJob): void {
    const history = [job, ...this.jobHistory$.value];
    this.jobHistory$.next(history.slice(0, 10)); // Keep last 10 jobs
  }

  /**
   * Clear current job
   */
  clearCurrentJob(): void {
    this.currentJob$.next(null);
  }
}
