// electron/services/python-service.ts
import { spawn, ChildProcess } from 'child_process';
import * as log from 'electron-log';
import { AppConfig } from '../config/app-config';
import * as path from 'path';

export interface PythonExecutionOptions {
  command: string;
  args: string[];
  onOutput?: (data: string) => void;
  onError?: (data: string) => void;
  onComplete?: (code: number) => void;
}

export interface WorkflowExecutionOptions {
  inputData: any;
  onOutput?: (data: string) => void;
  onError?: (data: string) => void;
  onProgress?: (progress: number, message: string) => void;
  onComplete?: (code: number, result?: any) => void;
}

// Common installation paths
const COMMON_PATHS = [
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
  process.env.HOME + '/Library/Python/3.11/bin',
  process.env.HOME + '/Library/Python/3.10/bin',
  process.env.HOME + '/Library/Python/3.9/bin',
  process.env.HOME + '/.local/bin',
].filter(Boolean).join(':');

/**
 * Service to execute Python CLI commands
 */
export class PythonService {
  private runningProcesses: Map<string, ChildProcess> = new Map();

  /**
   * Execute a Python CLI command
   */
  executePythonCommand(jobId: string, options: PythonExecutionOptions): ChildProcess {
    log.info(`Executing Python command [${jobId}]:`, options.command, options.args);

    // Build the full command
    const pythonPath = 'python3';
    const scriptPath = path.join(AppConfig.cliPath, 'main.py');

    // Set environment variables with enhanced PATH
    const env = {
      ...process.env,
      PATH: `${COMMON_PATHS}:${process.env.PATH || ''}`,
      PYTHONPATH: AppConfig.appPath,
      PYTHONUNBUFFERED: '1' // Ensure real-time output
    };

    // Spawn the Python process
    const pythonProcess = spawn(pythonPath, [scriptPath, options.command, ...options.args], {
      env,
      cwd: AppConfig.appPath
    });

    // Store the process
    this.runningProcesses.set(jobId, pythonProcess);

    // Handle stdout
    pythonProcess.stdout.on('data', (data) => {
      const output = data.toString();
      log.info(`[${jobId}] stdout:`, output);
      if (options.onOutput) {
        options.onOutput(output);
      }
    });

    // Handle stderr
    pythonProcess.stderr.on('data', (data) => {
      const error = data.toString();
      log.error(`[${jobId}] stderr:`, error);
      if (options.onError) {
        options.onError(error);
      }
    });

    // Handle process completion
    pythonProcess.on('close', (code) => {
      log.info(`[${jobId}] Process exited with code ${code}`);
      this.runningProcesses.delete(jobId);
      if (options.onComplete) {
        options.onComplete(code || 0);
      }
    });

    // Handle process errors
    pythonProcess.on('error', (error) => {
      log.error(`[${jobId}] Process error:`, error);
      this.runningProcesses.delete(jobId);
      if (options.onError) {
        options.onError(`Process error: ${error.message}`);
      }
    });

    return pythonProcess;
  }

  /**
   * Kill a running process
   */
  killProcess(jobId: string): boolean {
    const process = this.runningProcesses.get(jobId);
    if (process) {
      log.info(`Killing process [${jobId}]`);
      process.kill();
      this.runningProcesses.delete(jobId);
      return true;
    }
    return false;
  }

  /**
   * Kill all running processes
   */
  killAllProcesses(): void {
    log.info('Killing all running processes');
    this.runningProcesses.forEach((process, jobId) => {
      log.info(`Killing process [${jobId}]`);
      process.kill();
    });
    this.runningProcesses.clear();
  }

  /**
   * Get running process count
   */
  getRunningProcessCount(): number {
    return this.runningProcesses.size;
  }

  /**
   * Execute the electron workflow script with JSON input
   */
  executeWorkflow(jobId: string, options: WorkflowExecutionOptions): ChildProcess {
    log.info(`Executing workflow [${jobId}]`);

    const pythonPath = 'python3';
    const scriptPath = path.join(AppConfig.cliPath, 'electron_workflow.py');

    // Set environment variables with enhanced PATH
    const env = {
      ...process.env,
      PATH: `${COMMON_PATHS}:${process.env.PATH || ''}`,
      PYTHONPATH: AppConfig.appPath,
      PYTHONUNBUFFERED: '1'
    };

    // Spawn the Python process
    const pythonProcess = spawn(pythonPath, [scriptPath], {
      env,
      cwd: AppConfig.appPath
    });

    // Store the process
    this.runningProcesses.set(jobId, pythonProcess);

    // Send input data as JSON to stdin
    pythonProcess.stdin.write(JSON.stringify(options.inputData));
    pythonProcess.stdin.end();

    let finalResult: any = null;

    // Handle stdout - parse JSON messages
    pythonProcess.stdout.on('data', (data) => {
      const output = data.toString();
      log.info(`[${jobId}] Raw stdout:`, output);

      // Try to parse each line as JSON
      const lines = output.split('\n').filter(line => line.trim());
      for (const line of lines) {
        try {
          const message = JSON.parse(line);
          log.info(`[${jobId}] Parsed JSON message:`, message);

          if (message.type === 'progress' && options.onProgress) {
            log.info(`[${jobId}] Emitting progress: ${message.progress}% - ${message.message}`);
            options.onProgress(message.progress, message.message);
          } else if (message.type === 'error' && options.onError) {
            log.error(`[${jobId}] Emitting error:`, message.error);
            options.onError(message.error);
          } else if (message.type === 'success') {
            log.info(`[${jobId}] Workflow success:`, message.result);
            finalResult = message.result;
          }
        } catch (e) {
          // Not JSON, treat as regular output
          log.info(`[${jobId}] Non-JSON output:`, line);
          if (options.onOutput) {
            options.onOutput(line);
          }
        }
      }
    });

    // Handle stderr
    pythonProcess.stderr.on('data', (data) => {
      const error = data.toString();
      log.error(`[${jobId}] stderr:`, error);
      if (options.onError) {
        options.onError(error);
      }
    });

    // Handle process completion
    pythonProcess.on('close', (code) => {
      log.info(`[${jobId}] Workflow process exited with code ${code}`);
      this.runningProcesses.delete(jobId);
      if (options.onComplete) {
        options.onComplete(code || 0, finalResult);
      }
    });

    // Handle process errors
    pythonProcess.on('error', (error) => {
      log.error(`[${jobId}] Workflow process error:`, error);
      this.runningProcesses.delete(jobId);
      if (options.onError) {
        options.onError(`Process error: ${error.message}`);
      }
    });

    return pythonProcess;
  }
}
