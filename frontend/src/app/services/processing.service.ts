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
  // Structured error text emitted by Python (via stderr/error events), preferred
  // over regex-scraped console output when the job fails.
  emittedError?: string;
  // Success result payload from Python (zipPath/clips/session), delivered via the
  // workflow-complete callback rather than an output event.
  results?: any;
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
        message: this.truncateMessage(String(data.data ?? '')),
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
      try {
        const parsedData = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
        const updatedJob = {
          ...currentJob,
          skipDecisions: parsedData.decisions
        };
        this.currentJob$.next(updatedJob);
      } catch (e) {
        // Malformed payload — don't let it kill the subscription for the rest of the job.
        console.warn('[ProcessingService] Failed to parse skip_capabilities payload:', e);
      }
      return;
    }

    // Handle operation_start event (legacy format)
    if (data.type === 'operation_start') {
      try {
        const parsedData = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
        const updatedJob = {
          ...currentJob,
          currentOperation: parsedData.operation,
          canSkipCurrent: parsedData.can_skip,
          subProgress: 0  // Reset sub-progress
        };
        this.currentJob$.next(updatedJob);
      } catch (e) {
        // Malformed payload — don't let it kill the subscription for the rest of the job.
        console.warn('[ProcessingService] Failed to parse operation_start payload:', e);
      }
      return;
    }

    // Handle regular output — cap at 500 lines to prevent memory leaks
    const MAX_OUTPUT_LINES = 500;
    const line = String(data.data ?? '');
    let output: string[];
    if (currentJob.output.length >= MAX_OUTPUT_LINES) {
      // Drop oldest lines to stay within limit
      output = [...currentJob.output.slice(-MAX_OUTPUT_LINES + 1), line];
    } else {
      output = [...currentJob.output, line];
    }
    const updatedJob: ProcessingJob = {
      ...currentJob,
      output,
      message: this.extractLastMessage(output)
    };

    // Capture structured Python errors. The `type==='error'` payload is forwarded
    // by the main process through onError → a 'stderr' workflow-output event, so
    // both surface here as 'stderr' (or a defensive 'error'). Retain the latest
    // non-empty text so a failed job can prefer it over regex-scraped output.
    if ((data.type === 'stderr' || data.type === 'error') && line.trim()) {
      updatedJob.emittedError = line.trim();
    }

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
  private handleWorkflowComplete(data: { jobId: string; exitCode: number; result?: any }): void {
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
      // Prefer the structured error text Python emitted over regex-scraped console
      // output; fall back to scraping only when no structured error was captured.
      errorDetails = currentJob.emittedError || this.extractErrorDetails(currentJob.output);

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
      // The success result (zipPath/clips/session) only reaches the renderer via the
      // completion callback, so capture it here onto the job's results field.
      results: data.exitCode === 0 && data.result !== undefined ? data.result : currentJob.results,
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
    const lines = output.map(l => String(l ?? '')).join('').split('\n').filter(line => line.trim());
    const lastLine = lines[lines.length - 1] || 'Processing...';
    return this.truncateMessage(lastLine);
  }

  /**
   * Truncate message to max 100 characters for progress display
   */
  private truncateMessage(message: string, maxLength: number = 100): string {
    const str = String(message ?? '');
    if (str.length <= maxLength) {
      return str;
    }
    return str.substring(0, maxLength - 3) + '...';
  }

  /**
   * Add job to history — drops output to free memory
   */
  private addToHistory(job: ProcessingJob): void {
    // Keep only the last few output lines for error context, drop the rest
    const historyJob = {
      ...job,
      output: job.output.slice(-20)
    };
    const history = [historyJob, ...this.jobHistory$.value];
    this.jobHistory$.next(history.slice(0, 10));
  }

  /**
   * Clear current job
   */
  clearCurrentJob(): void {
    this.currentJob$.next(null);
  }
}
