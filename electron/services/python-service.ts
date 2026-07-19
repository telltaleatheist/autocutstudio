// electron/services/python-service.ts
import { spawn, ChildProcess } from 'child_process';
import * as log from 'electron-log';
import { AppConfig } from '../config/app-config';
import { BinaryResolver } from './binary-resolver';
import { DuganAutomixer, DuganTrack } from './dugan-automixer';
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

/**
 * Service to execute Python CLI commands
 */
export class PythonService {
  private runningProcesses: Map<string, ChildProcess> = new Map();
  private binaryResolver: BinaryResolver;

  constructor() {
    this.binaryResolver = new BinaryResolver();
    this.logPythonInfo();
  }

  /**
   * Log Python information for debugging
   */
  private logPythonInfo(): void {
    const pythonPath = this.binaryResolver.getPythonPath();
    log.info('PythonService initialized');
    log.info(`Python path: ${pythonPath}`);

    const binariesCheck = this.binaryResolver.checkBinaries();
    log.info('Binaries check:', binariesCheck);
  }

  /**
   * Get the Python path to use
   */
  private getPythonPath(): string {
    return this.binaryResolver.getPythonPath();
  }

  /**
   * Get the Python environment configuration
   */
  private getPythonEnv(): NodeJS.ProcessEnv {
    return this.binaryResolver.getPythonEnv();
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

    // Guarantee exactly one terminal callback, from EITHER 'close' or 'error'.
    let completed = false;
    const complete = (code: number) => {
      if (completed) return;
      completed = true;
      this.runningProcesses.delete(jobId);
      if (options.onComplete) {
        options.onComplete(code);
      }
    };

    // Handle process completion
    pythonProcess.on('close', (code, signal) => {
      if (code === null) {
        // A null exit code means the process was terminated by a signal
        // (segfault, OOM kill, SIGTERM). Coercing that to 0 would report a
        // killed pipeline as success — treat it as a hard failure instead.
        log.error(`[${jobId}] Process terminated by signal ${signal} (no exit code) — treating as failure`);
        complete(-1);
      } else {
        log.info(`[${jobId}] Process exited with code ${code}`);
        complete(code);
      }
    });

    // Handle process errors (e.g. spawn failure — the binary doesn't exist).
    // Previously onComplete never fired here, so the renderer would spin forever.
    pythonProcess.on('error', (error) => {
      log.error(`[${jobId}] Process error:`, error);
      if (options.onError) {
        options.onError(`Process error: ${error.message}`);
      }
      complete(-1);
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

    // Surface stdin errors instead of letting an EPIPE (Python exiting
    // immediately) bubble up as an uncaught exception that crashes main.
    pythonProcess.stdin.on('error', (err) => {
      log.error(`[${jobId}] stdin error:`, err);
    });

    // Send input data as JSON to stdin
    // NOTE: Don't close stdin - we need it open to send skip signals later
    pythonProcess.stdin.write(JSON.stringify(options.inputData) + '\n', (err) => {
      if (err) {
        log.error(`[${jobId}] Failed to write initial input to stdin:`, err);
      }
    });

    let finalResult: any = null;

    // Line buffer for stdout — Node.js data events don't guarantee
    // complete lines, so we must buffer and split on newlines to
    // avoid silently dropping JSON messages (like ducking_request).
    let stdoutBuffer = '';

    /**
     * Process a single complete line of stdout output.
     */
    const processLine = (line: string) => {
      // ── Parse only ── a JSON.parse failure genuinely means non-JSON output.
      let message: any;
      try {
        message = JSON.parse(line);
      } catch (e) {
        log.info(`[${jobId}] Non-JSON output:`, line);
        if (options.onOutput) {
          options.onOutput(line);
        }
        return;
      }

      // ── Dispatch ── a throw HERE (e.g. `message.tracks.length` on a malformed
      // ducking_request) is a real bug, not "non-JSON output". Log it loudly so
      // Python doesn't block forever waiting on a response we never sent.
      try {
        log.info(`[${jobId}] Parsed JSON message:`, message);

        if (message.type === 'progress' && options.onProgress) {
          log.info(`[${jobId}] Emitting progress: ${message.progress}% - ${message.message}`);
          options.onProgress(message.progress, message.message, message.sub_progress);
        } else if (message.type === 'operation_start' && options.onOutput) {
          log.info(`[${jobId}] Operation start:`, message);
          options.onOutput(JSON.stringify({ type: 'operation_start', data: { operation: message.operation, can_skip: message.can_skip } }));
        } else if (message.type === 'skip_capabilities' && options.onOutput) {
          log.info(`[${jobId}] Skip capabilities:`, message);
          options.onOutput(JSON.stringify({ type: 'skip_capabilities', data: { decisions: message.decisions } }));
        } else if (message.type === 'error' && options.onError) {
          log.error(`[${jobId}] Emitting error:`, message.error);
          options.onError(message.error);
        } else if (message.type === 'success') {
          log.info(`[${jobId}] Workflow success:`, message.result);
          finalResult = message.result;
        } else if (message.type === 'ducking_request') {
          // Validate before touching message.tracks — an invalid payload must not
          // throw (silently swallowed) and leave Python blocked. Instead reply
          // immediately with an error so Python can fail fast.
          if (!Array.isArray(message.tracks) || message.tracks.length === 0) {
            log.error(`[${jobId}] Invalid ducking_request: 'tracks' missing or empty`);
            const errResponse = JSON.stringify({
              type: 'ducking_complete',
              error: "Invalid ducking_request: 'tracks' must be a non-empty array"
            }) + '\n';
            if (!pythonProcess.stdin.destroyed) {
              pythonProcess.stdin.write(errResponse, (err) => {
                if (err) {
                  log.error(`[${jobId}] Failed to write ducking error response to stdin:`, err);
                }
              });
            } else {
              log.error(`[${jobId}] Cannot write ducking error response — stdin is destroyed`);
            }
            return;
          }

          // Run Dugan automixer on tracks Python sent us
          log.info(`[${jobId}] Ducking request received: ${message.tracks.length} tracks`);
          for (const t of message.tracks) {
            log.info(`[${jobId}]   Track: ${t.type} → ${t.path}`);
          }
          const dugan = new DuganAutomixer();
          const duganTracks: DuganTrack[] = (message.tracks || []).map((t: any) => ({
            type: t.type,
            filePath: t.path
          }));

          dugan.process(duganTracks).then((results) => {
            log.info(`[${jobId}] Dugan automixer completed successfully: ${results.length} tracks processed`);
            const response = JSON.stringify({
              type: 'ducking_complete',
              tracks: results.map(r => ({ type: r.type, path: r.filePath }))
            }) + '\n';
            if (!pythonProcess.stdin.destroyed) {
              pythonProcess.stdin.write(response, (err) => {
                if (err) {
                  log.error(`[${jobId}] Failed to write Dugan response to stdin:`, err);
                }
              });
            } else {
              log.error(`[${jobId}] Cannot write Dugan response — stdin is destroyed`);
            }
          }).catch((err) => {
            log.error(`[${jobId}] Dugan automixer FAILED:`, err);
            const response = JSON.stringify({
              type: 'ducking_complete',
              error: err.message
            }) + '\n';
            if (!pythonProcess.stdin.destroyed) {
              pythonProcess.stdin.write(response, (err2) => {
                if (err2) {
                  log.error(`[${jobId}] Failed to write Dugan error response to stdin:`, err2);
                }
              });
            }
          });
        }
      } catch (dispatchErr) {
        // A dispatch failure is a real error — do NOT relabel it "non-JSON output".
        log.error(`[${jobId}] Error dispatching workflow message:`, dispatchErr);
        if (options.onError) {
          options.onError(`Error handling workflow message: ${(dispatchErr as Error).message}`);
        }
      }
    };

    // Handle stdout with proper line buffering
    pythonProcess.stdout.on('data', (data) => {
      const output = data.toString();
      log.info(`[${jobId}] Raw stdout:`, output);

      // Append to buffer and process complete lines
      stdoutBuffer += output;
      const lines = stdoutBuffer.split('\n');
      // Keep the last element (incomplete line) in the buffer
      stdoutBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          processLine(trimmed);
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

    // Guarantee exactly one terminal callback, from EITHER 'close' or 'error'.
    let completed = false;
    const complete = (code: number, result?: any) => {
      if (completed) return;
      completed = true;
      this.runningProcesses.delete(jobId);

      // Remove all listeners to release closure references
      pythonProcess.stdout.removeAllListeners();
      pythonProcess.stderr.removeAllListeners();
      pythonProcess.stdin.removeAllListeners();
      pythonProcess.removeAllListeners();

      if (options.onComplete) {
        options.onComplete(code, result);
      }

      // Release closure references
      stdoutBuffer = '';
      finalResult = null;
    };

    // Handle process completion
    pythonProcess.on('close', (code, signal) => {
      // Flush any remaining data in the line buffer
      if (stdoutBuffer.trim()) {
        processLine(stdoutBuffer.trim());
      }

      if (code === null) {
        // A null exit code means the process was killed by a signal
        // (segfault, OOM, SIGTERM). Never coerce that to 0 — a killed pipeline
        // is a failure, not success.
        log.error(`[${jobId}] Workflow terminated by signal ${signal} (no exit code) — treating as failure`);
        complete(-1, finalResult);
      } else {
        log.info(`[${jobId}] Workflow process exited with code ${code}`);
        complete(code, finalResult);
      }
    });

    // Handle process errors (e.g. spawn failure). Previously onComplete never
    // fired here, so the renderer spun forever waiting on workflow-complete.
    pythonProcess.on('error', (error) => {
      log.error(`[${jobId}] Workflow process error:`, error);
      if (options.onError) {
        options.onError(`Process error: ${error.message}`);
      }
      complete(-1, finalResult);
    });

    return pythonProcess;
  }

  /**
   * Run electron_workflow.py in MEASURE-ONLY mode: spawn Python, send the run options
   * (with measureOnly:true) on stdin, and resolve with the single parsed measurement
   * result ({ audio: {...}, video: {...} }, per source { offsetSeconds, confidence,
   * trusted }). Reuses the same spawn / env / line-buffered stdout parsing as
   * executeWorkflow. Rejects — never fabricates a result — on a Python-side error, a
   * non-zero / signalled exit, or a spawn failure.
   */
  measureAlignment(jobId: string, inputData: any): Promise<any> {
    log.info(`Measuring alignment [${jobId}]`);

    const pythonPath = this.getPythonPath();
    const scriptPath = path.join(AppConfig.cliPath, 'electron_workflow.py');
    const env = this.getPythonEnv();
    const workingDir = AppConfig.resourcesPath;

    return new Promise((resolve, reject) => {
      const pythonProcess = spawn(pythonPath, [scriptPath], { env, cwd: workingDir });
      this.runningProcesses.set(jobId, pythonProcess);

      let measureResult: any = null;
      let errorMessage: string | null = null;
      let stdoutBuffer = '';

      pythonProcess.stdin.on('error', (err) => {
        log.error(`[${jobId}] stdin error:`, err);
      });
      pythonProcess.stdin.write(JSON.stringify({ ...inputData, measureOnly: true }) + '\n', (err) => {
        if (err) {
          log.error(`[${jobId}] Failed to write measure input to stdin:`, err);
        }
      });

      // Only two message types matter here: the single measure_result, and any error.
      const processLine = (line: string) => {
        let message: any;
        try {
          message = JSON.parse(line);
        } catch (e) {
          log.info(`[${jobId}] Non-JSON output:`, line);
          return;
        }
        if (message.type === 'measure_result') {
          measureResult = message.sources;
        } else if (message.type === 'error') {
          errorMessage = message.error;
        }
      };

      pythonProcess.stdout.on('data', (data) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) {
            processLine(trimmed);
          }
        }
      });

      pythonProcess.stderr.on('data', (data) => {
        log.info(`[${jobId}] stderr:`, data.toString());
      });

      // Guarantee exactly one settle, from EITHER 'close' or 'error'.
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        this.runningProcesses.delete(jobId);
        pythonProcess.stdout.removeAllListeners();
        pythonProcess.stderr.removeAllListeners();
        pythonProcess.stdin.removeAllListeners();
        pythonProcess.removeAllListeners();
        fn();
      };

      pythonProcess.on('close', (code, signal) => {
        if (stdoutBuffer.trim()) {
          processLine(stdoutBuffer.trim());
        }
        if (code === 0 && measureResult) {
          finish(() => resolve(measureResult));
        } else {
          const reason = errorMessage
            || (code === null ? `terminated by signal ${signal}` : `exited with code ${code}`)
            || 'no measurement result produced';
          log.error(`[${jobId}] Measure-only failed: ${reason}`);
          finish(() => reject(new Error(reason)));
        }
      });

      pythonProcess.on('error', (error) => {
        log.error(`[${jobId}] Measure process error:`, error);
        finish(() => reject(error));
      });
    });
  }

  /**
   * Send skip signal to the current running workflow process
   */
  sendSkipSignal(): boolean {
    // SIGUSR1 doesn't exist on Windows — calling kill('SIGUSR1') there would
    // terminate the whole workflow instead of skipping the current step.
    if (process.platform === 'win32') {
      log.warn('[SKIP] ⚠️  Skip via SIGUSR1 is not supported on Windows — ignoring skip request');
      return false;
    }

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
