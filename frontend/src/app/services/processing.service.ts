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
  // Skip functionality
  currentOperation?: string;
  canSkipCurrent?: boolean;
  subProgress?: number;
  skipDecisions?: any;
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
  private handleWorkflowOutput(data: { jobId: string; type: string; data: string; progress?: number; sub_progress?: number }): void {
    const currentJob = this.currentJob$.value;

    if (!currentJob || currentJob.id !== data.jobId) {
      return;
    }

    // Handle progress updates
    if (data.type === 'progress' && data.progress !== undefined) {
      const updatedJob = {
        ...currentJob,
        progress: data.progress,
        message: this.truncateMessage(data.data),
        subProgress: data.sub_progress || 0
      };
      this.currentJob$.next(updatedJob);
      return;
    }

    // For stdout type, try to parse data as JSON to check for special events
    if (data.type === 'stdout' && typeof data.data === 'string') {
      try {
        const parsed = JSON.parse(data.data);

        // Handle skip_capabilities event
        if (parsed.type === 'skip_capabilities') {
          const updatedJob = {
            ...currentJob,
            skipDecisions: parsed.data.decisions
          };
          this.currentJob$.next(updatedJob);
          return;
        }

        // Handle operation_start event
        if (parsed.type === 'operation_start') {
          const updatedJob = {
            ...currentJob,
            currentOperation: parsed.data.operation,
            canSkipCurrent: parsed.data.can_skip,
            subProgress: 0  // Reset sub-progress
          };
          this.currentJob$.next(updatedJob);
          return;
        }
      } catch (e) {
        // Not JSON or different format, treat as regular output
      }
    }

    // Handle skip_capabilities event (legacy format)
    if (data.type === 'skip_capabilities') {
      const parsedData = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
      const updatedJob = {
        ...currentJob,
        skipDecisions: parsedData.decisions
      };
      this.currentJob$.next(updatedJob);
      return;
    }

    // Handle operation_start event (legacy format)
    if (data.type === 'operation_start') {
      const parsedData = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
      const updatedJob = {
        ...currentJob,
        currentOperation: parsedData.operation,
        canSkipCurrent: parsedData.can_skip,
        subProgress: 0  // Reset sub-progress
      };
      this.currentJob$.next(updatedJob);
      return;
    }

    // Handle regular output
    const output = [...currentJob.output, data.data];
    const updatedJob = {
      ...currentJob,
      output,
      message: this.extractLastMessage(output)
    };

    this.currentJob$.next(updatedJob);
  }

  /**
   * Extract error details from console output
   */
  private extractErrorDetails(output: string[]): string {
    const allOutput = output.join('\n');
    const lines = allOutput.split('\n').filter(line => line.trim());

    // Look for common error patterns
    const errorPatterns = [
      /Error:/i,
      /Exception:/i,
      /Traceback/i,
      /ModuleNotFoundError:/i,
      /ImportError:/i,
      /FileNotFoundError:/i,
      /PermissionError:/i,
      /failed/i,
      /cannot/i
    ];

    // Find lines with errors (last 20 lines for context)
    const recentLines = lines.slice(-20);
    const errorLines: string[] = [];

    for (const line of recentLines) {
      if (errorPatterns.some(pattern => pattern.test(line))) {
        errorLines.push(line);
      }
    }

    // If we found error lines, return them
    if (errorLines.length > 0) {
      return errorLines.join('\n');
    }

    // Otherwise return last 5 lines as context
    return recentLines.slice(-5).join('\n');
  }

  /**
   * Handle workflow completion
   */
  private handleWorkflowComplete(data: { jobId: string; exitCode: number }): void {
    console.log('[ProcessingService] Received workflow-complete event:', data);
    const currentJob = this.currentJob$.value;
    console.log('[ProcessingService] Current job at completion:', currentJob);

    if (!currentJob || currentJob.id !== data.jobId) {
      console.warn('[ProcessingService] Ignoring completion - no matching job', { currentJobId: currentJob?.id, dataJobId: data.jobId });
      return;
    }

    console.log(`[ProcessingService] Marking job as ${data.exitCode === 0 ? 'completed' : 'error'}`);

    // Extract detailed error information if workflow failed
    let errorMessage = '';
    let errorDetails = '';

    if (data.exitCode !== 0) {
      errorDetails = this.extractErrorDetails(currentJob.output);

      // Create a user-friendly error message
      if (errorDetails.includes('ModuleNotFoundError') || errorDetails.includes('ImportError')) {
        const match = errorDetails.match(/No module named '([^']+)'/);
        const moduleName = match ? match[1] : 'unknown';
        errorMessage = `Missing Python package: ${moduleName}. The system will attempt to install it automatically on next run.`;
      } else if (errorDetails.includes('FileNotFoundError')) {
        errorMessage = 'A required file was not found. Please check your input files and try again.';
      } else if (errorDetails.includes('PermissionError')) {
        errorMessage = 'Permission denied. Please check file permissions and try again.';
      } else {
        errorMessage = 'Workflow failed. See error details below.';
      }
    }

    const updatedJob = {
      ...currentJob,
      status: data.exitCode === 0 ? 'completed' as const : 'error' as const,
      progress: 100,
      message: data.exitCode === 0 ? 'Workflow completed successfully!' : errorMessage,
      error: data.exitCode !== 0 ? errorDetails : undefined,
      endTime: new Date()
    };

    this.currentJob$.next(updatedJob);
    this.addToHistory(updatedJob);
    console.log('[ProcessingService] Job marked as complete and added to history');

    // Show detailed error dialog for failures
    if (data.exitCode !== 0) {
      this.showErrorDialog(errorMessage, errorDetails);
    }
  }

  /**
   * Show error dialog with details
   */
  private showErrorDialog(message: string, details: string): void {
    // Create a more detailed error message
    const fullMessage = `${message}\n\n━━━ Error Details ━━━\n${details}\n\n📋 This error has been logged. Check the console output for more information.`;

    // Use alert for now (can be replaced with a custom dialog component)
    alert(fullMessage);
  }

  /**
   * Extract last meaningful message from output and truncate if needed
   */
  private extractLastMessage(output: string[]): string {
    const lines = output.join('').split('\n').filter(line => line.trim());
    const lastLine = lines[lines.length - 1] || 'Processing...';
    return this.truncateMessage(lastLine);
  }

  /**
   * Truncate message to max 100 characters for progress display
   */
  private truncateMessage(message: string, maxLength: number = 100): string {
    if (message.length <= maxLength) {
      return message;
    }
    return message.substring(0, maxLength - 3) + '...';
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
