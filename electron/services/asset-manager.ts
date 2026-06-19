/**
 * Asset Manager — orchestrates download → verify → extract → record for the
 * catalog, installs into the per-machine OwenMorgan shared location, and resolves
 * paths for the rest of the app.
 *
 * Resolution reconstructs paths from (category, subdir, entry) against the
 * CURRENT shared base every time — it never trusts a stored absolute path — so a
 * relocated store or a per-app fallback still resolves, and a binary another
 * OwenMorgan app already installed is picked up automatically.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { app } from 'electron';
import * as log from 'electron-log';

import { migrateLegacyDir, getSharedDir } from '../shared-paths';
import { downloadFileWithRetry, verifySha256, extractArchive, findFile } from './downloader';
import { getCatalog, getComponent } from './asset-catalog';
import type {
  AssetArtifact,
  AssetCategory,
  AssetComponent,
  ComponentState,
  ComponentStatus,
  InstalledRecord,
  InstalledState,
  InstallProgress,
  InstallResult,
  Platform,
  Arch,
} from './asset-types';

// ─────────────────────────────────────────────────────────────────────────────
// Paths — all resolved against the CURRENT shared base
// ─────────────────────────────────────────────────────────────────────────────

function currentPlatform(): Platform {
  return process.platform as Platform;
}
function currentArch(): Arch {
  return process.arch === 'arm64' ? 'arm64' : 'x64';
}

/** Resolve a shared category dir, migrating any legacy per-app copy in once.
 *  Falls back to per-app userData when the shared base isn't writable. */
function categoryDir(category: AssetCategory): string {
  const legacy = path.join(app.getPath('userData'), 'assets', category);
  return migrateLegacyDir(legacy, category);
}

/** Absolute install dir for a component (category dir + its subdir). */
function installDirFor(component: AssetComponent): string {
  return path.join(categoryDir(component.category), component.installSubdir || component.id);
}

/** App-namespaced state file; lives in the shared base (with per-app fallback). */
function stateDir(): string {
  const legacy = path.join(app.getPath('userData'), 'assets', 'state');
  return migrateLegacyDir(legacy, 'autocutstudio');
}
function statePath(): string {
  return path.join(stateDir(), 'installed.json');
}

function readState(): InstalledState {
  try {
    const p = statePath();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (data && typeof data === 'object' && data.components) return data as InstalledState;
    }
  } catch (err) {
    log.warn('[ASSETS] Could not read installed.json:', err);
  }
  return { components: {} };
}

function writeState(state: InstalledState): void {
  try {
    const p = statePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    log.warn('[ASSETS] Could not write installed.json:', err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution (presence-on-disk is the source of truth)
// ─────────────────────────────────────────────────────────────────────────────

function withExe(name: string): string {
  return process.platform === 'win32' && !name.toLowerCase().endsWith('.exe')
    ? `${name}.exe`
    : name;
}

/** Absolute path to a named executable a component provides, or null. Searches
 *  the install dir directly, then recursively by basename (archives often nest). */
export function resolveBinary(id: string, binaryName: string): string | null {
  const component = getComponent(id);
  if (!component) return null;
  const dir = installDirFor(component);
  if (!fs.existsSync(dir)) return null;

  const wanted = withExe(binaryName);
  const direct = path.join(dir, wanted);
  if (fs.existsSync(direct)) return direct;

  const lower = wanted.toLowerCase();
  return findFile(dir, (f) => f.toLowerCase() === lower);
}

/** Absolute path to a component's single entry (model file / interpreter), or null. */
export function resolveEntry(id: string): string | null {
  const component = getComponent(id);
  if (!component?.entry) return null;
  const dir = installDirFor(component);
  const entryAbs = path.join(dir, component.entry);
  return fs.existsSync(entryAbs) ? entryAbs : null;
}

/** The install dir for a component if it exists on disk, else null (e.g. the
 *  Python env root, for building PATH / PYTHONHOME). */
export function resolveDir(id: string): string | null {
  const component = getComponent(id);
  if (!component) return null;
  const dir = installDirFor(component);
  return fs.existsSync(dir) ? dir : null;
}

/** True when all of a component's declared entrypoints resolve on disk. */
export function isInstalled(id: string): boolean {
  const component = getComponent(id);
  if (!component) return false;
  if (component.binaries && component.binaries.length > 0) {
    return component.binaries.every((b) => resolveBinary(id, b) !== null);
  }
  if (component.entry) return resolveEntry(id) !== null;
  return resolveDir(id) !== null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status
// ─────────────────────────────────────────────────────────────────────────────

function pickArtifact(component: AssetComponent): AssetArtifact | null {
  const p = currentPlatform();
  const a = currentArch();
  return component.artifacts.find((art) => art.platform === p && art.arch === a) ?? null;
}

/** An artifact is "published" once it has a real URL and either a checksum or a
 *  known size. Catalog placeholders (sha256:'' , bytes:0) are not yet uploaded —
 *  attempting them just 404s, so ensureRequired skips them. */
function isPublished(artifact: AssetArtifact | null): boolean {
  return !!artifact?.url && (!!artifact.sha256 || artifact.bytes > 0);
}

export function listStatus(): ComponentStatus[] {
  const state = readState();
  return getCatalog().map((component) => {
    const rec = state.components[component.id];
    const installed = isInstalled(component.id);
    const artifact = pickArtifact(component);
    let s: ComponentState;
    if (installing.has(component.id)) s = 'installing';
    else if (installed) s = 'installed';
    else s = 'available';
    return {
      id: component.id,
      name: component.name,
      description: component.description,
      required: !!component.required,
      state: s,
      installable: installed || isPublished(artifact),
      sizeBytes: artifact?.bytes ?? 0,
      version: component.version,
      installed: installed ? rec : undefined,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Install
// ─────────────────────────────────────────────────────────────────────────────

const installing = new Map<string, AbortController>();

function basenameFromUrl(url: string, fallback: string): string {
  try {
    const base = path.basename(new URL(url).pathname);
    return base || fallback;
  } catch {
    return fallback;
  }
}

/** Surface the real error from a failed child process (stderr/stdout, not just
 *  the generic "Command failed" message). */
function execErr(err: unknown): string {
  const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
  const out = (e?.stderr || e?.stdout)?.toString().trim();
  return out || e?.message || String(err);
}

/** Run a component's post-extract step inside its install dir. */
function runPostInstall(component: AssetComponent, installDir: string, emit: (p: InstallProgress) => void): void {
  if (component.postInstall !== 'conda-unpack') return;

  emit({ id: component.id, phase: 'postinstall', pct: 0, message: 'Finalizing Python environment…' });

  const isWin = process.platform === 'win32';
  const py = isWin ? path.join(installDir, 'python.exe') : path.join(installDir, 'bin', 'python3');
  if (!isWin && fs.existsSync(py)) {
    try {
      fs.chmodSync(py, 0o755);
    } catch {
      /* ignore */
    }
  }

  const unpack = isWin
    ? path.join(installDir, 'Scripts', 'conda-unpack.exe')
    : path.join(installDir, 'bin', 'conda-unpack');
  if (fs.existsSync(unpack)) {
    try {
      if (isWin) {
        execFileSync(unpack, [], { stdio: 'pipe' });
      } else {
        // Invoke conda-unpack through the env's own python rather than relying on
        // its `#!/usr/bin/env python` shebang — a packaged macOS GUI app has a
        // minimal PATH with no `python`, so the shebang would fail to launch.
        fs.chmodSync(unpack, 0o755);
        execFileSync(py, [unpack], { stdio: 'pipe' });
      }
    } catch (err) {
      throw new Error(`conda-unpack failed: ${execErr(err)}`);
    }
  } else {
    log.warn(`[ASSETS] conda-unpack not found in env: ${unpack}`);
  }

  // Smoke test: prove the interpreter actually launches before marking ready.
  if (fs.existsSync(py)) {
    try {
      const out = execFileSync(py, ['--version'], { encoding: 'utf-8' }).trim();
      log.info(`[ASSETS] python-env smoke test: ${out}`);
    } catch (err) {
      throw new Error(`python smoke test failed: ${execErr(err)}`);
    }
  }
  emit({ id: component.id, phase: 'postinstall', pct: 100, message: 'Python environment ready' });
}

export async function install(
  id: string,
  onProgress?: (p: InstallProgress) => void
): Promise<InstallResult> {
  const component = getComponent(id);
  if (!component) return { id, ok: false, error: `Unknown component: ${id}` };

  const emit = (p: InstallProgress) => {
    try {
      onProgress?.(p);
    } catch {
      /* ignore listener errors */
    }
  };

  const ac = new AbortController();
  installing.set(id, ac);
  const installDir = installDirFor(component);
  // Stage into a sibling dir, then atomically swap in — never clobber a working
  // install (possibly placed by another OwenMorgan app) until the new one is ready.
  const staging = `${installDir}.installing-${process.pid}`;

  try {
    emit({ id, phase: 'resolve', pct: 0, message: 'Preparing…' });

    const artifact = pickArtifact(component);
    if (!artifact || !artifact.url) {
      throw new Error(`No download available for ${currentPlatform()}-${currentArch()} yet`);
    }

    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });

    if (artifact.kind === 'file') {
      const fileName = artifact.fileName || component.entry || basenameFromUrl(artifact.url, id);
      const dest = path.join(staging, fileName);
      const tmp = `${dest}.part`;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await downloadFileWithRetry(artifact.url, tmp, id, emit, ac.signal);
      await verifySha256(tmp, artifact.sha256, id, emit);
      fs.renameSync(tmp, dest);
    } else {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `autocut-${id}-`));
      const archivePath = path.join(tmpRoot, basenameFromUrl(artifact.url, 'artifact'));
      try {
        await downloadFileWithRetry(artifact.url, archivePath, id, emit, ac.signal);
        await verifySha256(archivePath, artifact.sha256, id, emit);
        emit({ id, phase: 'extract', pct: 0, message: 'Extracting…' });
        await extractArchive(archivePath, staging, artifact.url);
        emit({ id, phase: 'extract', pct: 100, message: 'Extracted' });
      } finally {
        try {
          fs.rmSync(tmpRoot, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }

    if (ac.signal.aborted) throw new Error('Install cancelled');

    // Make declared binaries executable before validation/swap.
    if (process.platform !== 'win32' && component.binaries) {
      for (const b of component.binaries) {
        const found = findFile(staging, (f) => f.toLowerCase() === withExe(b).toLowerCase());
        if (found) {
          try {
            fs.chmodSync(found, 0o755);
          } catch {
            /* ignore */
          }
        }
      }
    }

    // Run post-extract step (e.g. conda-unpack) in the staging dir.
    runPostInstall(component, staging, emit);

    // Atomic swap: remove any previous install, move staging into place.
    fs.mkdirSync(path.dirname(installDir), { recursive: true });
    fs.rmSync(installDir, { recursive: true, force: true });
    fs.renameSync(staging, installDir);

    if (!isInstalled(id)) {
      throw new Error(`Install completed but entrypoints not found in ${installDir}`);
    }

    const record: InstalledRecord = {
      id,
      version: component.version,
      category: component.category,
      subdir: component.installSubdir || component.id,
      sha256: artifact.sha256 || undefined,
      bytes: artifact.bytes || undefined,
      installedAt: new Date().toISOString(),
    };
    const state = readState();
    state.components[id] = record;
    writeState(state);

    emit({ id, phase: 'done', pct: 100, message: 'Installed' });
    return { id, ok: true, record };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`[ASSETS] install ${id} failed: ${message}`);
    emit({ id, phase: 'error', pct: 0, message });
    return { id, ok: false, error: message };
  } finally {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    installing.delete(id);
  }
}

/** Abort an in-flight install (no-op if none running). */
export function cancel(id: string): void {
  installing.get(id)?.abort();
}

/**
 * Ensure every required component is installed, downloading any that are missing.
 * Returns the list of component ids that failed (empty = all good). Components
 * already present (including ones installed by another OwenMorgan app) are skipped.
 */
export async function ensureRequired(
  onProgress?: (p: InstallProgress) => void
): Promise<{ ok: boolean; failed: string[] }> {
  const failed: string[] = [];
  log.info(`[ASSETS] Shared dir: ${safeSharedDir()}`);
  for (const component of getCatalog()) {
    if (!component.required) continue;
    if (isInstalled(component.id)) {
      log.info(`[ASSETS] ${component.id} already present — skipping`);
      continue;
    }
    if (!isPublished(pickArtifact(component))) {
      log.warn(`[ASSETS] ${component.id} not published for this platform yet — skipping (app will use fallback)`);
      continue;
    }
    log.info(`[ASSETS] Installing required component: ${component.id}`);
    const res = await install(component.id, onProgress);
    if (!res.ok) failed.push(component.id);
  }
  return { ok: failed.length === 0, failed };
}

function safeSharedDir(): string {
  try {
    return getSharedDir();
  } catch {
    return '(unavailable)';
  }
}
