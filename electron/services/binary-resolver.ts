// electron/services/binary-resolver.ts
import * as path from 'path';
import * as fs from 'fs';
import * as log from 'electron-log';
import { AppConfig } from '../config/app-config';

/**
 * Service to resolve paths to bundled binaries
 *
 * This service looks for bundled binaries in the extraResources directory
 * and falls back to system binaries if bundled versions are not found.
 */
export class BinaryResolver {
  private binariesPath: string;
  private pythonPath: string;

  constructor() {
    // Determine platform-specific directory
    // Note: In production, electron-builder copies the correct platform dir to 'binaries'
    // In development, we need to look in the platform-specific subdirectory
    const platformDir = this.getPlatformDir();

    // In production, binaries are in extraResources (already platform-specific)
    // In development, they're in the project root under platform subdirs
    if (AppConfig.isDevelopment) {
      this.binariesPath = path.join(AppConfig.resourcesPath, 'binaries', platformDir);
      this.pythonPath = path.join(AppConfig.resourcesPath, 'python', platformDir);
    } else {
      // In production, electron-builder already copied the right platform dir
      this.binariesPath = path.join(AppConfig.resourcesPath, 'binaries');
      this.pythonPath = path.join(AppConfig.resourcesPath, 'python');
    }

    log.info('BinaryResolver initialized');
    log.info(`App architecture (process.arch): ${process.arch}`);
    log.info(`Platform directory: ${platformDir}`);
    log.info(`Development mode: ${AppConfig.isDevelopment}`);

    // Detect if running under Rosetta
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      const isRosetta = this.detectRosetta();
      if (isRosetta) {
        log.info('⚠️  Running ARM64 build on Intel Mac via Rosetta');
        log.info('   Using ARM64 binaries (will be translated by Rosetta)');
      }
    }

    log.info(`Binaries path: ${this.binariesPath}`);
    log.info(`Python path: ${this.pythonPath}`);
  }

  /**
   * Detect if running under Rosetta (ARM64 app on Intel Mac)
   * Returns true if running under Rosetta, false otherwise
   */
  private detectRosetta(): boolean {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
      return false;
    }

    try {
      const { execSync } = require('child_process');
      // sysctl returns 1 if running under Rosetta, 0 if native ARM64
      const result = execSync('sysctl -in sysctl.proc_translated', { encoding: 'utf8' }).trim();
      return result === '1';
    } catch (error) {
      // If the command fails, we're likely on native ARM64
      // (the sysctl key doesn't exist on native ARM64)
      return false;
    }
  }

  /**
   * Get platform-specific directory name
   * Maps Node.js platform names to electron-builder naming convention
   *
   * IMPORTANT: This returns the APP's build architecture (process.arch),
   * NOT the hardware architecture. This ensures we look for binaries
   * that match the bundled architecture:
   * - ARM64 build → looks for ARM64 binaries (even if running on Intel via Rosetta)
   * - Intel build → looks for x64 binaries
   */
  private getPlatformDir(): string {
    const platform = process.platform === 'darwin' ? 'mac' :
                     process.platform === 'win32' ? 'win' : 'linux';
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    return `${platform}-${arch}`;
  }

  /**
   * Find a bundled binary by name
   * Returns the full path to the binary if found, null otherwise
   */
  private findBundledBinary(binaryName: string): string | null {
    const binaryPath = path.join(this.binariesPath, binaryName);

    try {
      if (fs.existsSync(binaryPath)) {
        // Check if file is executable
        try {
          fs.accessSync(binaryPath, fs.constants.X_OK);
          log.info(`Found bundled binary: ${binaryPath}`);
          return binaryPath;
        } catch (e) {
          log.warn(`Bundled binary exists but is not executable: ${binaryPath}`);
          // Try to make it executable
          try {
            fs.chmodSync(binaryPath, 0o755);
            log.info(`Made bundled binary executable: ${binaryPath}`);
            return binaryPath;
          } catch (chmodError) {
            log.error(`Failed to make binary executable: ${chmodError}`);
            return null;
          }
        }
      }
    } catch (error) {
      log.warn(`Error checking for bundled binary ${binaryName}:`, error);
    }

    return null;
  }

  /**
   * Find a system binary using 'which' command
   */
  private findSystemBinary(binaryName: string): string | null {
    const { execSync } = require('child_process');

    try {
      // Common paths to check
      const commonPaths = [
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/usr/bin',
        '/bin',
      ];

      // Try common paths first (faster than 'which')
      for (const dirPath of commonPaths) {
        const fullPath = path.join(dirPath, binaryName);
        if (fs.existsSync(fullPath)) {
          log.info(`Found system binary in common path: ${fullPath}`);
          return fullPath;
        }
      }

      // Fall back to 'which' command
      const result = execSync(`which ${binaryName}`, { encoding: 'utf8' }).trim();
      if (result) {
        log.info(`Found system binary via which: ${result}`);
        return result;
      }
    } catch (error) {
      // 'which' returns non-zero exit code if binary not found
      log.debug(`System binary ${binaryName} not found via which`);
    }

    return null;
  }

  /**
   * Get the path to ffmpeg binary
   * Prefers bundled version, falls back to system binary
   */
  getFfmpegPath(): string {
    const bundled = this.findBundledBinary('ffmpeg');
    if (bundled) return bundled;

    const system = this.findSystemBinary('ffmpeg');
    if (system) return system;

    // Final fallback - just return 'ffmpeg' and hope it's in PATH
    log.warn('ffmpeg not found in bundled binaries or system, returning "ffmpeg"');
    return 'ffmpeg';
  }

  /**
   * Get the path to ffprobe binary
   * Prefers bundled version, falls back to system binary
   */
  getFfprobePath(): string {
    const bundled = this.findBundledBinary('ffprobe');
    if (bundled) return bundled;

    const system = this.findSystemBinary('ffprobe');
    if (system) return system;

    log.warn('ffprobe not found in bundled binaries or system, returning "ffprobe"');
    return 'ffprobe';
  }

  /**
   * Get the path to Python binary
   * Prefers bundled version, falls back to conda, then system Python
   */
  getPythonPath(): string {
    // Check for bundled Python runtime
    const bundledPython = path.join(this.pythonPath, 'python-runtime', 'bin', 'python3');
    if (fs.existsSync(bundledPython)) {
      log.info(`Found bundled Python: ${bundledPython}`);
      return bundledPython;
    }

    // Check for conda environment (for development)
    const condaPython = '/opt/homebrew/Caskroom/miniconda/base/envs/autocutstudio/bin/python3';
    if (fs.existsSync(condaPython)) {
      log.info(`Found conda Python: ${condaPython}`);
      return condaPython;
    }

    // Fall back to system Python
    const systemPython = this.findSystemBinary('python3');
    if (systemPython) {
      log.info(`Found system Python: ${systemPython}`);
      return systemPython;
    }

    // Final fallback
    log.warn('Python not found in bundled runtime, conda, or system, returning "python3"');
    return 'python3';
  }

  /**
   * Get the path to auto-editor binary
   * This is typically a Python package, so it should be in the Python environment
   */
  getAutoEditorPath(): string {
    // Check bundled Python environment
    const bundledAutoEditor = path.join(this.pythonPath, 'python-runtime', 'bin', 'auto-editor');
    if (fs.existsSync(bundledAutoEditor)) {
      log.info(`Found bundled auto-editor: ${bundledAutoEditor}`);
      return bundledAutoEditor;
    }

    // Check system/conda
    const system = this.findSystemBinary('auto-editor');
    if (system) return system;

    log.warn('auto-editor not found, returning "auto-editor"');
    return 'auto-editor';
  }

  /**
   * Get Python environment variables
   * Includes PATH to bundled binaries if they exist
   */
  getPythonEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PYTHONPATH: AppConfig.resourcesPath
    };

    // Add bundled binaries to PATH if they exist
    const pathComponents: string[] = [];

    if (fs.existsSync(this.binariesPath)) {
      pathComponents.push(this.binariesPath);
    }

    const bundledPythonBin = path.join(this.pythonPath, 'python-runtime', 'bin');
    if (fs.existsSync(bundledPythonBin)) {
      pathComponents.push(bundledPythonBin);
    }

    // Add common system paths
    pathComponents.push('/usr/local/bin');
    pathComponents.push('/opt/homebrew/bin');
    pathComponents.push('/usr/bin');
    pathComponents.push('/bin');

    // Add existing PATH
    if (process.env.PATH) {
      pathComponents.push(process.env.PATH);
    }

    env.PATH = pathComponents.join(':');

    return env;
  }

  /**
   * Check if all required binaries are available
   */
  checkBinaries(): {
    python: boolean;
    ffmpeg: boolean;
    ffprobe: boolean;
    autoEditor: boolean;
  } {
    return {
      python: fs.existsSync(this.getPythonPath()) || this.findSystemBinary('python3') !== null,
      ffmpeg: fs.existsSync(this.getFfmpegPath()) || this.findSystemBinary('ffmpeg') !== null,
      ffprobe: fs.existsSync(this.getFfprobePath()) || this.findSystemBinary('ffprobe') !== null,
      autoEditor: fs.existsSync(this.getAutoEditorPath()) || this.findSystemBinary('auto-editor') !== null,
    };
  }
}
