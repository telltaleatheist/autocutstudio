// electron/services/dependency-service.ts
import { exec } from 'child_process';
import { promisify } from 'util';
import * as log from 'electron-log';

const execAsync = promisify(exec);

// Common installation paths for Homebrew and system binaries
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

// Augment PATH with common locations
const execEnv = {
  ...process.env,
  PATH: `${COMMON_PATHS}:${process.env.PATH || ''}`
};

export interface DependencyCheckResult {
  available: boolean;
  version?: string;
  path?: string;
  error?: string;
}

export interface AllDependenciesResult {
  python: DependencyCheckResult;
  ffmpeg: DependencyCheckResult;
  ffprobe: DependencyCheckResult;
  autoEditor: DependencyCheckResult;
  allAvailable: boolean;
}

/**
 * Service to check for required system dependencies
 */
export class DependencyService {
  /**
   * Check if Python 3 is installed
   */
  async checkPython(): Promise<DependencyCheckResult> {
    try {
      const { stdout } = await execAsync('python3 --version', { env: execEnv });
      const version = stdout.trim();

      // Get path
      const { stdout: pathStdout } = await execAsync('which python3', { env: execEnv });
      const path = pathStdout.trim();

      log.info(`Python found: ${version} at ${path}`);
      return { available: true, version, path };
    } catch (error: any) {
      log.error('Python not found:', error.message);
      return {
        available: false,
        error: 'Python 3 is not installed or not in PATH'
      };
    }
  }

  /**
   * Check if ffmpeg is installed
   */
  async checkFfmpeg(): Promise<DependencyCheckResult> {
    try {
      const { stdout } = await execAsync('ffmpeg -version', { env: execEnv });
      const version = stdout.split('\n')[0];

      const { stdout: pathStdout } = await execAsync('which ffmpeg', { env: execEnv });
      const path = pathStdout.trim();

      log.info(`ffmpeg found: ${version} at ${path}`);
      return { available: true, version, path };
    } catch (error: any) {
      log.error('ffmpeg not found:', error.message);
      return {
        available: false,
        error: 'ffmpeg is not installed or not in PATH'
      };
    }
  }

  /**
   * Check if ffprobe is installed
   */
  async checkFfprobe(): Promise<DependencyCheckResult> {
    try {
      const { stdout } = await execAsync('ffprobe -version', { env: execEnv });
      const version = stdout.split('\n')[0];

      const { stdout: pathStdout } = await execAsync('which ffprobe', { env: execEnv });
      const path = pathStdout.trim();

      log.info(`ffprobe found: ${version} at ${path}`);
      return { available: true, version, path };
    } catch (error: any) {
      log.error('ffprobe not found:', error.message);
      return {
        available: false,
        error: 'ffprobe is not installed or not in PATH'
      };
    }
  }

  /**
   * Check if auto-editor is installed
   */
  async checkAutoEditor(): Promise<DependencyCheckResult> {
    try {
      const { stdout } = await execAsync('auto-editor --version', { env: execEnv });
      const version = stdout.trim();

      const { stdout: pathStdout } = await execAsync('which auto-editor', { env: execEnv });
      const path = pathStdout.trim();

      log.info(`auto-editor found: ${version} at ${path}`);
      return { available: true, version, path };
    } catch (error: any) {
      log.error('auto-editor not found:', error.message);
      return {
        available: false,
        error: 'auto-editor is not installed or not in PATH'
      };
    }
  }

  /**
   * Check all dependencies
   */
  async checkAllDependencies(): Promise<AllDependenciesResult> {
    log.info('Checking system dependencies...');

    const [python, ffmpeg, ffprobe, autoEditor] = await Promise.all([
      this.checkPython(),
      this.checkFfmpeg(),
      this.checkFfprobe(),
      this.checkAutoEditor()
    ]);

    const allAvailable = python.available &&
                         ffmpeg.available &&
                         ffprobe.available &&
                         autoEditor.available;

    if (allAvailable) {
      log.info('All dependencies are available');
    } else {
      log.warn('Some dependencies are missing');
    }

    return {
      python,
      ffmpeg,
      ffprobe,
      autoEditor,
      allAvailable
    };
  }
}
