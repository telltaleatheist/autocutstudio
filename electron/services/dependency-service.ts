// electron/services/dependency-service.ts
import { exec } from 'child_process';
import { promisify } from 'util';
import * as log from 'electron-log';
import { BinaryResolver } from './binary-resolver';

const execAsync = promisify(exec);

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
  private binaryResolver: BinaryResolver;

  constructor() {
    this.binaryResolver = new BinaryResolver();
  }

  /**
   * Check if a binary is available and get its version
   */
  private async checkBinary(
    binaryPath: string,
    versionArg: string = '--version'
  ): Promise<DependencyCheckResult> {
    try {
      const env = this.binaryResolver.getPythonEnv();
      const { stdout } = await execAsync(`"${binaryPath}" ${versionArg}`, { env });
      const version = stdout.split('\n')[0].trim();

      log.info(`Binary found: ${binaryPath} - ${version}`);
      return { available: true, version, path: binaryPath };
    } catch (error: any) {
      log.error(`Binary not found or error: ${binaryPath}`, error.message);
      return {
        available: false,
        error: `Binary not available: ${binaryPath}`
      };
    }
  }

  /**
   * Check if Python 3 is installed
   */
  async checkPython(): Promise<DependencyCheckResult> {
    const pythonPath = this.binaryResolver.getPythonPath();
    return this.checkBinary(pythonPath, '--version');
  }

  /**
   * Check if ffmpeg is installed
   */
  async checkFfmpeg(): Promise<DependencyCheckResult> {
    const ffmpegPath = this.binaryResolver.getFfmpegPath();
    return this.checkBinary(ffmpegPath, '-version');
  }

  /**
   * Check if ffprobe is installed
   */
  async checkFfprobe(): Promise<DependencyCheckResult> {
    const ffprobePath = this.binaryResolver.getFfprobePath();
    return this.checkBinary(ffprobePath, '-version');
  }

  /**
   * Check if auto-editor is installed
   */
  async checkAutoEditor(): Promise<DependencyCheckResult> {
    const autoEditorPath = this.binaryResolver.getAutoEditorPath();
    return this.checkBinary(autoEditorPath, '--version');
  }

  /**
   * Check if a Python package is installed
   */
  async checkPythonPackage(packageName: string): Promise<PythonPackageCheckResult> {
    try {
      const pythonPath = this.binaryResolver.getPythonPath();
      const env = this.binaryResolver.getPythonEnv();

      // Try to import the package and get its version
      const importName = packageName === 'pillow' ? 'PIL' : packageName;
      const { stdout } = await execAsync(
        `"${pythonPath}" -c "import ${importName}; print(${importName}.__version__)"`,
        { env }
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
      const pythonPath = this.binaryResolver.getPythonPath();
      const env = this.binaryResolver.getPythonEnv();

      log.info(`Installing Python package: ${packageName}`);
      const { stdout, stderr } = await execAsync(
        `"${pythonPath}" -m pip install ${packageName}`,
        { env, timeout: 120000 } // 2 minute timeout
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
