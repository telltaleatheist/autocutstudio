// electron/services/binary-resolver.ts
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { app } from 'electron';
import * as log from 'electron-log';
import { AppConfig } from '../config/app-config';
import * as assetManager from './asset-manager';

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
   * Verify a binary actually runs, not just that the file exists. A bundled
   * binary can exist + be executable yet abort at launch (missing dylib, wrong
   * arch) — that's what caused the original ffprobe SIGABRT. Returns true only
   * if the process launches and exits without throwing.
   */
  private binaryWorks(binPath: string, args: string[]): boolean {
    try {
      execFileSync(binPath, args, { stdio: 'ignore', timeout: 10_000 });
      return true;
    } catch (error) {
      log.warn(`Binary failed validation (${binPath}): ${(error as Error).message}`);
      return false;
    }
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
    // 1. Managed shared download (cross-app OwenMorgan location), validated.
    const managed = assetManager.resolveBinary('ffmpeg-tools', 'ffmpeg');
    if (managed && this.binaryWorks(managed, ['-version'])) {
      log.info(`Using managed ffmpeg: ${managed}`);
      return managed;
    }

    // 2. Bundled binary — but only if it actually runs.
    const bundled = this.findBundledBinary('ffmpeg');
    if (bundled && this.binaryWorks(bundled, ['-version'])) return bundled;

    // 3. System binary.
    const system = this.findSystemBinary('ffmpeg');
    if (system) return system;

    // Final fallback - just return 'ffmpeg' and hope it's in PATH
    log.warn('ffmpeg not found in managed, bundled, or system, returning "ffmpeg"');
    return 'ffmpeg';
  }

  /**
   * Get the path to ffprobe binary
   * Prefers bundled version, falls back to system binary
   */
  getFfprobePath(): string {
    // 1. Managed shared download (cross-app OwenMorgan location), validated.
    const managed = assetManager.resolveBinary('ffmpeg-tools', 'ffprobe');
    if (managed && this.binaryWorks(managed, ['-version'])) {
      log.info(`Using managed ffprobe: ${managed}`);
      return managed;
    }

    // 2. Bundled binary — but only if it actually runs.
    const bundled = this.findBundledBinary('ffprobe');
    if (bundled && this.binaryWorks(bundled, ['-version'])) return bundled;

    // 3. System binary.
    const system = this.findSystemBinary('ffprobe');
    if (system) return system;

    log.warn('ffprobe not found in managed, bundled, or system, returning "ffprobe"');
    return 'ffprobe';
  }

  /**
   * Get the path to Python binary
   * Prefers bundled version, falls back to conda, then system Python
   */
  getPythonPath(): string {
    // Check the managed shared Python env first (downloaded from GH releases).
    const managedPython = assetManager.resolveEntry('python-env');
    if (managedPython && this.binaryWorks(managedPython, ['--version'])) {
      log.info(`Using managed Python env: ${managedPython}`);
      return managedPython;
    }

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
    // 1. Managed shared Python env (downloaded from GH releases).
    const envDir = assetManager.resolveDir('python-env');
    if (envDir) {
      const managedAE = process.platform === 'win32'
        ? path.join(envDir, 'Scripts', 'auto-editor.exe')
        : path.join(envDir, 'bin', 'auto-editor');
      if (fs.existsSync(managedAE)) {
        log.info(`Using managed auto-editor: ${managedAE}`);
        return managedAE;
      }
    }

    // 2. Bundled Python environment.
    const bundledAutoEditor = path.join(this.pythonPath, 'python-runtime', 'bin', 'auto-editor');
    if (fs.existsSync(bundledAutoEditor)) {
      log.info(`Found bundled auto-editor: ${bundledAutoEditor}`);
      return bundledAutoEditor;
    }

    // 3. System/conda.
    const system = this.findSystemBinary('auto-editor');
    if (system) return system;

    log.warn('auto-editor not found, returning "auto-editor"');
    return 'auto-editor';
  }

  /**
   * Resolve the optional voice-isolation (audio-separator) env directory.
   * This is the managed, conda-packed env downloaded into the shared OwenMorgan
   * location; returns its absolute root, or null when not installed.
   * Mirrors the managed alt-env resolution used by getAutoEditorPath.
   */
  getVoiceSeparatorEnvDir(): string | null {
    return assetManager.resolveDir('voice-separator-env');
  }

  /**
   * Resolve the Python interpreter inside the voice-isolation env, or null when
   * the env isn't installed. Uses the catalog `entry` (bin/python3 on unix,
   * python.exe on Windows).
   */
  getVoiceSeparatorPython(): string | null {
    const envDir = this.getVoiceSeparatorEnvDir();
    if (!envDir) return null;
    const py = process.platform === 'win32'
      ? path.join(envDir, 'python.exe')
      : path.join(envDir, 'bin', 'python3');
    return fs.existsSync(py) ? py : null;
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

    // Point the Python side at the SAME config directory the Settings UI writes
    // to, so user-edited speed factors (drift_corrections.json) actually reach
    // the pipeline. Packaged → userData/config; dev → the project root's config/
    // (mirrors electron/ipc/ipc-handlers.ts getBundledConfigPath dev resolution).
    env.AUTOCUT_CONFIG_DIR = app.isPackaged
      ? path.join(app.getPath('userData'), 'config')
      : path.join(__dirname, '../../../../', 'config');

    // Build PATH so the Python subprocess's bare `ffmpeg`/`ffprobe`/`auto-editor`
    // calls resolve to our managed binaries first, then bundled, then system.
    const pathComponents: string[] = [];

    // 1. Managed shared binaries (validated working ffmpeg/ffprobe).
    const managedFfmpeg = assetManager.resolveBinary('ffmpeg-tools', 'ffmpeg');
    if (managedFfmpeg) {
      pathComponents.push(path.dirname(managedFfmpeg));
    }
    const managedPython = assetManager.resolveEntry('python-env');
    if (managedPython) {
      pathComponents.push(path.dirname(managedPython));
    }

    // 2. Bundled binaries.
    if (fs.existsSync(this.binariesPath)) {
      pathComponents.push(this.binariesPath);
    }

    const bundledPythonBin = path.join(this.pythonPath, 'python-runtime', 'bin');
    if (fs.existsSync(bundledPythonBin)) {
      pathComponents.push(bundledPythonBin);
    }

    // Add common system paths — these are unix-only, so don't pollute PATH with
    // them on Windows (where PATH is ';'-delimited and these dirs don't exist).
    if (process.platform !== 'win32') {
      pathComponents.push('/usr/local/bin');
      pathComponents.push('/opt/homebrew/bin');
      pathComponents.push('/usr/bin');
      pathComponents.push('/bin');
    }

    // Add existing PATH
    if (process.env.PATH) {
      pathComponents.push(process.env.PATH);
    }

    env.PATH = pathComponents.join(path.delimiter);

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
