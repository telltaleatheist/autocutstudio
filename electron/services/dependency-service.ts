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

export interface PythonPackageCheckResult {
  available: boolean;
  version?: string;
  error?: string;
  installAttempted?: boolean;
}

export interface AllDependenciesResult {
  python: DependencyCheckResult;
  ffmpeg: DependencyCheckResult;
  ffprobe: DependencyCheckResult;
  autoEditor: DependencyCheckResult;
  pythonPackages?: {
    numpy: PythonPackageCheckResult;
    pillow: PythonPackageCheckResult;
    scipy: PythonPackageCheckResult;
    librosa: PythonPackageCheckResult;
  };
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
   * Check if a Python package is installed
   */
  async checkPythonPackage(packageName: string): Promise<PythonPackageCheckResult> {
    try {
      // Try to import the package and get its version
      const importName = packageName === 'pillow' ? 'PIL' : packageName;
      const { stdout } = await execAsync(
        `python3 -c "import ${importName}; print(${importName}.__version__)"`,
        { env: execEnv }
      );
      const version = stdout.trim();
      log.info(`Python package ${packageName} found: ${version}`);
      return { available: true, version };
    } catch (error: any) {
      log.warn(`Python package ${packageName} not found`);
      return { available: false, error: `Package ${packageName} is not installed` };
    }
  }

  /**
   * Install a Python package using pip
   */
  async installPythonPackage(packageName: string): Promise<PythonPackageCheckResult> {
    try {
      log.info(`Installing Python package: ${packageName}`);
      const { stdout, stderr } = await execAsync(
        `python3 -m pip install ${packageName}`,
        { env: execEnv, timeout: 120000 } // 2 minute timeout
      );

      log.info(`Install output: ${stdout}`);
      if (stderr) log.warn(`Install warnings: ${stderr}`);

      // Verify installation
      const result = await this.checkPythonPackage(packageName);
      if (result.available) {
        log.info(`Successfully installed ${packageName} ${result.version}`);
        return { ...result, installAttempted: true };
      } else {
        return {
          available: false,
          error: `Failed to verify ${packageName} after installation`,
          installAttempted: true
        };
      }
    } catch (error: any) {
      log.error(`Failed to install ${packageName}:`, error.message);
      return {
        available: false,
        error: `Installation failed: ${error.message}`,
        installAttempted: true
      };
    }
  }

  /**
   * Check and auto-install required Python packages
   */
  async checkPythonPackages(autoInstall: boolean = true): Promise<{
    numpy: PythonPackageCheckResult;
    pillow: PythonPackageCheckResult;
    scipy: PythonPackageCheckResult;
    librosa: PythonPackageCheckResult;
  }> {
    log.info('Checking required Python packages...');

    const packages = ['numpy', 'pillow', 'scipy', 'librosa'];
    const results: any = {};

    for (const pkg of packages) {
      let result = await this.checkPythonPackage(pkg);

      // If package is missing and auto-install is enabled, try to install it
      if (!result.available && autoInstall) {
        log.info(`Package ${pkg} is missing, attempting to install...`);
        result = await this.installPythonPackage(pkg);
      }

      results[pkg] = result;
    }

    return results;
  }

  /**
   * Check all dependencies
   */
  async checkAllDependencies(checkPythonPackages: boolean = true): Promise<AllDependenciesResult> {
    log.info('Checking system dependencies...');

    const [python, ffmpeg, ffprobe, autoEditor] = await Promise.all([
      this.checkPython(),
      this.checkFfmpeg(),
      this.checkFfprobe(),
      this.checkAutoEditor()
    ]);

    let pythonPackages;
    if (checkPythonPackages && python.available) {
      pythonPackages = await this.checkPythonPackages(true);
    }

    const allAvailable = python.available &&
                         ffmpeg.available &&
                         ffprobe.available &&
                         autoEditor.available &&
                         (!pythonPackages || (
                           pythonPackages.numpy.available &&
                           pythonPackages.pillow.available &&
                           pythonPackages.scipy.available &&
                           pythonPackages.librosa.available
                         ));

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
      pythonPackages,
      allAvailable
    };
  }
}
