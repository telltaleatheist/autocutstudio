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

  // Resolved-path caches: resolution validates the binary by SPAWNING it
  // (`-version`), so re-resolving on every call (e.g. once per waveform peak
  // extraction) both spams the log and doubles the process spawns. A successful
  // resolution is stable for the process lifetime; the not-found fallback is NOT
  // cached so an install completed mid-session gets picked up.
  private cachedFfmpegPath: string | null = null;
  private cachedFfprobePath: string | null = null;
  // Whisper resolutions are validated by SPAWNING the binary (-h), so cache the
  // successful result for the process lifetime like ffmpeg/ffprobe. Not-found is
  // NOT cached (throws), so installing the model mid-session is picked up.
  private cachedWhisperCliPath: string | null = null;
  private cachedWhisperModelPath: string | null = null;

  /**
   * Bundled whisper-cli filename for THIS machine's arch. The utilities/bin dir ships
   * per-arch binaries whose ggml/whisper dylibs are @loader_path-linked with matching
   * -x64 / (unsuffixed arm64) names, so each binary loads its own arch's libs and the
   * two sets coexist without collision:
   *   - Apple Silicon (arm64): `whisper-cli` — the proven Metal build (~40x realtime).
   *   - Intel (x64): `whisper-cli-x64` — a CPU/BLAS build (no Metal on Intel Macs).
   *   - Windows: `whisper-cli.exe`.
   * (This mirrors the arch-selection pattern used by the sibling ContentStudio app,
   * which is how those x64 artifacts originate.)
   */
  private whisperBinaryName(): string {
    if (process.platform === 'win32') return 'whisper-cli.exe';
    if (process.platform === 'darwin') {
      return process.arch === 'arm64' ? 'whisper-cli' : 'whisper-cli-x64';
    }
    return 'whisper-cli';
  }

  /**
   * On macOS, confirm a Mach-O binary actually contains THIS process's architecture
   * before we try to run it — a wrong-arch binary otherwise fails with a confusing
   * dyld error. Fails loud on mismatch; a `file` probe that itself errors is not
   * treated as a mismatch (binaryWorks(-h) is the real gate right after). Mirrors
   * ContentStudio's verifyBinary.
   */
  private assertBinaryArch(binaryPath: string, name: string): void {
    if (process.platform !== 'darwin') return;
    let out: string;
    try {
      const { execSync } = require('child_process');
      out = execSync(`file "${binaryPath}"`, { encoding: 'utf8' });
    } catch {
      return; // couldn't probe; the -h run below is the authoritative check
    }
    const expected = process.arch === 'arm64' ? 'arm64' : 'x86_64';
    if (!(out.includes(expected) || out.includes('universal'))) {
      throw new Error(
        `${name} has the wrong architecture for this machine (need ${expected}): ${out.trim()}`
      );
    }
  }

  /**
   * Get the path to the whisper.cpp CLI binary for THIS machine's architecture (see
   * whisperBinaryName — arm64 Metal build, x64 CPU build, or the .exe). A plain
   * `whisper` on PATH is NOT acceptable, so there is deliberately NO PATH fallback.
   * Order: managed catalog entry (future-proofing; no such entry yet, so resolveBinary
   * returns null), then the arch-specific bundled binary under utilities/bin.
   *
   * The bundled binary is resolved dev-vs-packaged the same way other bundled resources
   * are: AppConfig.resourcesPath is the project root in development and
   * process.resourcesPath in production. A bundled binary that exists but lacks +x is
   * chmod'd; its arch is verified against this machine; and — critically — a binary
   * that exists but does NOT actually run (-h) is a hard THROW, never a fallback.
   */
  getWhisperCliPath(): string {
    if (this.cachedWhisperCliPath) return this.cachedWhisperCliPath;

    const binName = this.whisperBinaryName();

    // 1. Managed shared download (no catalog entry yet → resolveBinary returns null).
    const managed = assetManager.resolveBinary('whisper-cli', binName);
    if (managed && this.binaryWorks(managed, ['-h'])) {
      log.info(`Using managed whisper-cli: ${managed}`);
      this.cachedWhisperCliPath = managed;
      return managed;
    }

    // 2. Bundled arch-specific binary under utilities/bin.
    const bundled = path.join(AppConfig.resourcesPath, 'utilities', 'bin', binName);
    if (fs.existsSync(bundled)) {
      // Ensure it's executable — a freshly copied bundled binary may lack +x.
      try {
        fs.accessSync(bundled, fs.constants.X_OK);
      } catch {
        try {
          fs.chmodSync(bundled, 0o755);
          log.info(`Made bundled whisper-cli executable: ${bundled}`);
        } catch (chmodError) {
          throw new Error(
            `Whisper binary found but is not executable and chmod failed: ${bundled} ` +
            `(${(chmodError as Error).message}).`
          );
        }
      }
      // Wrong architecture is a loud, specific failure rather than a cryptic dyld error.
      this.assertBinaryArch(bundled, 'Whisper binary');
      // Exists + executable + right arch, but must actually RUN — a non-running binary
      // (missing dylib, bad build) is a throw, not a silent fallback.
      if (!this.binaryWorks(bundled, ['-h'])) {
        throw new Error(
          `Whisper binary found at ${bundled} but it failed to run (-h) — it may be ` +
          `missing its ggml dylibs.`
        );
      }
      log.info(`Using bundled whisper-cli: ${bundled}`);
      this.cachedWhisperCliPath = bundled;
      return bundled;
    }

    // NO PATH fallback — the transcription pipeline needs the exact bundled build.
    throw new Error(
      `Whisper binary not found — expected a bundled binary at utilities/bin/${binName}.`
    );
  }

  /**
   * Get the path to the whisper base model (ggml-base.bin). Order: the managed
   * `whisper-base` catalog entry (a REAL entry — installable from Settings → Assets;
   * resolveEntry returns null only when not installed), then the bundled
   * utilities/models/ggml-base.bin (resolved dev-vs-packaged via AppConfig.resourcesPath
   * exactly like getWhisperCliPath). Throws — no PATH/guess fallback — with an
   * actionable install message when neither exists.
   */
  getWhisperModelPath(): string {
    if (this.cachedWhisperModelPath) return this.cachedWhisperModelPath;

    // The shipped model is BASE, installed by the first-launch setup screen as a
    // REQUIRED asset (no model menu — the app picks). The preference chain below exists
    // for real transitional states, never as a silent substitute: a dev checkout with a
    // local model bundled, or a machine that installed a heavier model under an older
    // catalog. base wins first; a larger locally-present model is only used when base
    // itself is absent. Whichever is used is logged AND recorded in the transcript
    // sidecar's 'model' field, so provenance is always visible.
    const candidates: Array<{ kind: 'managed' | 'bundled'; name: string; p: string | null }> = [];
    candidates.push({ kind: 'managed', name: 'base', p: assetManager.resolveEntry('whisper-base') });
    for (const size of ['base', 'small', 'medium', 'large-v3']) {
      candidates.push({
        kind: 'bundled', name: size,
        p: path.join(AppConfig.resourcesPath, 'utilities', 'models', `ggml-${size}.bin`),
      });
    }
    for (const c of candidates) {
      if (c.p && fs.existsSync(c.p)) {
        log.info(`Using ${c.kind} whisper ${c.name} model: ${c.p}`);
        this.cachedWhisperModelPath = c.p;
        return c.p;
      }
    }

    throw new Error(
      'Whisper model not installed — restart the app to run first-launch setup, ' +
      'or install it from Settings → Assets.'
    );
  }

  /**
   * Get the path to ffmpeg binary
   * Prefers bundled version, falls back to system binary
   */
  getFfmpegPath(): string {
    if (this.cachedFfmpegPath) return this.cachedFfmpegPath;

    // 1. Managed shared download (cross-app OwenMorgan location), validated.
    const managed = assetManager.resolveBinary('ffmpeg-tools', 'ffmpeg');
    if (managed && this.binaryWorks(managed, ['-version'])) {
      log.info(`Using managed ffmpeg: ${managed}`);
      this.cachedFfmpegPath = managed;
      return managed;
    }

    // 2. Bundled binary — but only if it actually runs.
    const bundled = this.findBundledBinary('ffmpeg');
    if (bundled && this.binaryWorks(bundled, ['-version'])) {
      this.cachedFfmpegPath = bundled;
      return bundled;
    }

    // 3. System binary.
    const system = this.findSystemBinary('ffmpeg');
    if (system) {
      this.cachedFfmpegPath = system;
      return system;
    }

    // Final fallback - just return 'ffmpeg' and hope it's in PATH
    log.warn('ffmpeg not found in managed, bundled, or system, returning "ffmpeg"');
    return 'ffmpeg';
  }

  /**
   * Get the path to ffprobe binary
   * Prefers bundled version, falls back to system binary
   */
  getFfprobePath(): string {
    if (this.cachedFfprobePath) return this.cachedFfprobePath;

    // 1. Managed shared download (cross-app OwenMorgan location), validated.
    const managed = assetManager.resolveBinary('ffmpeg-tools', 'ffprobe');
    if (managed && this.binaryWorks(managed, ['-version'])) {
      log.info(`Using managed ffprobe: ${managed}`);
      this.cachedFfprobePath = managed;
      return managed;
    }

    // 2. Bundled binary — but only if it actually runs.
    const bundled = this.findBundledBinary('ffprobe');
    if (bundled && this.binaryWorks(bundled, ['-version'])) {
      this.cachedFfprobePath = bundled;
      return bundled;
    }

    // 3. System binary.
    const system = this.findSystemBinary('ffprobe');
    if (system) {
      this.cachedFfprobePath = system;
      return system;
    }

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
