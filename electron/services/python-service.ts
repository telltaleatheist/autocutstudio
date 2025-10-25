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
  onProgress?: (progress: number, message: string, subProgress?: number) => void;
  onComplete?: (code: number, result?: any) => void;
}

// Common installation paths (fallback when bundled Python not found)
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
  private bundledPythonPath: string | null = null;

  constructor() {
    this.findBundledPython();
  }

  /**
   * Find Python - always use system Python
   */
  private findBundledPython(): void {
    // Always use system Python - no bundled Python anymore
    this.bundledPythonPath = null;
    log.info('Using system Python from PATH');
  }

  /**
   * Get the Python path to use (bundled or system)
   */
  private getPythonPath(): string {
    return this.bundledPythonPath || 'python3';
  }

  /**
   * Get the Python environment configuration
   */
  private getPythonEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONUNBUFFERED: '1', // Ensure real-time output
      PATH: `${COMMON_PATHS}:${process.env.PATH || ''}`,
      PYTHONPATH: AppConfig.resourcesPath
    };

    log.info('Using system Python with PATH:', env.PATH);

    return env;
  }

  /**
   * Execute a Python CLI command
   */
  executePythonCommand(jobId: string, options: PythonExecutionOptions): ChildProcess {
    log.info(`Executing Python command [${jobId}]:`, options.command, options.args);

    // Build the full command
    const pythonPath = this.getPythonPath();
    const scriptPath = path.join(AppConfig.cliPath, 'main.py');

    // Get environment variables
    const env = this.getPythonEnv();

    // Use resourcesPath as cwd since appPath may be an .asar file in production
    const workingDir = AppConfig.resourcesPath;

    // Spawn the Python process
    const pythonProcess = spawn(pythonPath, [scriptPath, options.command, ...options.args], {
      env,
      cwd: workingDir
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

    // Use bundled Python if available, otherwise fall back to system python3
    const pythonPath = this.getPythonPath();
    const scriptPath = path.join(AppConfig.cliPath, 'electron_workflow.py');

    // Get environment variables (includes bundled Python configuration if available)
    const env = this.getPythonEnv();

    // Use resourcesPath as cwd since appPath may be an .asar file in production
    const workingDir = AppConfig.resourcesPath;

    // Spawn the Python process
    const pythonProcess = spawn(pythonPath, [scriptPath], {
      env,
      cwd: workingDir
    });

    // Store the process
    this.runningProcesses.set(jobId, pythonProcess);

    // Send input data as JSON to stdin
    // NOTE: Don't close stdin - we need it open to send skip signals later
    pythonProcess.stdin.write(JSON.stringify(options.inputData) + '\n');

    let finalResult: any = null;

    // Handle stdout - parse JSON messages
    pythonProcess.stdout.on('data', (data) => {
      const output = data.toString();
      log.info(`[${jobId}] Raw stdout:`, output);

      // Try to parse each line as JSON
      const lines = output.split('\n').filter((line: string) => line.trim());
      for (const line of lines) {
        try {
          const message = JSON.parse(line);
          log.info(`[${jobId}] Parsed JSON message:`, message);

          if (message.type === 'progress' && options.onProgress) {
            log.info(`[${jobId}] Emitting progress: ${message.progress}% - ${message.message}`);
            options.onProgress(message.progress, message.message, message.sub_progress);
          } else if (message.type === 'operation_start' && options.onOutput) {
            log.info(`[${jobId}] Operation start:`, message);
            // Send as structured output so processing service can handle it
            options.onOutput(JSON.stringify({ type: 'operation_start', data: { operation: message.operation, can_skip: message.can_skip } }));
          } else if (message.type === 'skip_capabilities' && options.onOutput) {
            log.info(`[${jobId}] Skip capabilities:`, message);
            // Send as structured output so processing service can handle it
            options.onOutput(JSON.stringify({ type: 'skip_capabilities', data: { decisions: message.decisions } }));
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

  /**
   * Send skip signal to the current running workflow process
   */
  sendSkipSignal(): boolean {
    // Get the most recent running process (the current workflow)
    const processes = Array.from(this.runningProcesses.values());
    log.info(`[SKIP] Total running processes: ${processes.length}`);

    if (processes.length > 0) {
      const currentProcess = processes[processes.length - 1];
      const pid = currentProcess.pid;

      log.info(`[SKIP] Current process PID: ${pid}`);

      if (currentProcess && pid) {
        try {
          // Send SIGUSR1 signal to Python process
          // This is much more reliable than stdin which has character loss issues
          log.info(`[SKIP] ✅ Sending SIGUSR1 signal to PID ${pid}`);
          currentProcess.kill('SIGUSR1');
          log.info('[SKIP] ✅ SIGUSR1 signal sent successfully');
          return true;
        } catch (error) {
          log.error('[SKIP] ❌ Error sending SIGUSR1:', error);
          return false;
        }
      } else {
        log.warn('[SKIP] ⚠️  Process or PID not available');
      }
    }
    log.warn('[SKIP] ⚠️  No active workflow process to send skip signal to');
    return false;
  }
}
