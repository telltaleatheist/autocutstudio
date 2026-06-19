/**
 * OwenMorgan shared application data.
 *
 * A single, cross-app, per-machine location where large REUSABLE assets are
 * stored ONCE and shared by every OwenMorgan app installed on the machine
 * (BookForge, Briefcase, …). A 9 GB local LLM (e.g. cogito 14b) or a managed
 * ffmpeg should not be duplicated per app — each app resolves these paths here
 * and checks for an existing asset before downloading.
 *
 * Locations (per-machine, NOT synced — these are big and machine-specific):
 *   macOS:   ~/Library/Application Support/OwenMorgan
 *   Windows: %LOCALAPPDATA%\OwenMorgan      (Local, not Roaming — too large to roam)
 *   Linux:   $XDG_DATA_HOME/OwenMorgan  or  ~/.local/share/OwenMorgan
 *
 * Override the whole base with OWENMORGAN_SHARED_DIR (testing / custom installs).
 *
 * PORTABLE BY DESIGN: this file depends only on Node built-ins, so it can be
 * copied verbatim into any other OwenMorgan Electron/Node app. Keep it that way
 * — do not import app-specific modules here.
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const VENDOR = 'OwenMorgan';

/**
 * Absolute path to the shared base dir, created if missing. Cheap and
 * idempotent — safe to call on every resolution. Throws only if the base
 * genuinely cannot be created (callers wanting a fallback should use
 * migrateLegacyDir, which handles that).
 */
export function getSharedDir(): string {
  const override = process.env.OWENMORGAN_SHARED_DIR?.trim();
  let base: string;

  if (override) {
    base = override;
  } else if (process.platform === 'darwin') {
    base = path.join(os.homedir(), 'Library', 'Application Support', VENDOR);
  } else if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    base = path.join(local, VENDOR);
  } else {
    const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    base = path.join(dataHome, VENDOR);
  }

  fs.mkdirSync(base, { recursive: true });
  return base;
}

/** Absolute path to a named sub-directory of the shared base, created if missing. */
export function sharedSubdir(name: string): string {
  const dir = path.join(getSharedDir(), name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function hasContent(dir: string): boolean {
  try {
    return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Prove a directory is actually usable by creating it and round-tripping a
 * probe file. mkdirSync succeeding is NOT enough: if the dir already exists but
 * is read-only, mkdirSync({recursive}) is a no-op that succeeds, yet writes
 * still fail. Returns true only if we can both create the dir and write in it.
 */
function isWritable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.om-write-probe-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

const warned = new Set<string>();
function warnOnce(msg: string): void {
  if (warned.has(msg)) return;
  warned.add(msg);
  // Portable: no app logger here. console.warn is visible in main-process logs.
  console.warn(`[shared-paths] ${msg}`);
}

/**
 * Resolve a shared sub-directory, migrating a legacy per-app location into it
 * exactly once so existing installs keep their already-downloaded assets
 * instead of re-downloading.
 *
 * Behaviour:
 *   - If the shared base can't be created or written (no permission, read-only
 *     volume, a file where the dir should be, a bad OWENMORGAN_SHARED_DIR), fall
 *     back to the per-app `legacyDir` so the app still works — just without
 *     cross-app sharing. Never throws for this; that's the whole point.
 *   - Else if the shared dir already has content, return it (no clobber).
 *   - Else if the legacy dir has content, MOVE it into the shared location
 *     (atomic rename on the same volume; copy fallback across volumes).
 *   - Else just return the (empty, writable) shared dir.
 *
 * @param legacyDir  Absolute path to the old per-app directory (may not exist).
 * @param sharedName Sub-directory name under the shared base.
 */
export function migrateLegacyDir(legacyDir: string, sharedName: string): string {
  // Establish a *writable* shared dir, or fall back to per-app storage.
  let shared: string | null = null;
  try {
    shared = path.join(getSharedDir(), sharedName);
  } catch (err) {
    warnOnce(`shared base unavailable (${(err as Error).message}); using per-app storage at ${legacyDir}`);
  }

  if (!shared || !isWritable(shared)) {
    if (shared) warnOnce(`shared dir not writable (${shared}); using per-app storage at ${legacyDir}`);
    fs.mkdirSync(legacyDir, { recursive: true });
    return legacyDir;
  }

  // isWritable() already created `shared` (and left it empty), so this only runs
  // when the shared location is confirmed usable.
  try {
    if (!hasContent(shared) && hasContent(legacyDir) && path.resolve(legacyDir) !== path.resolve(shared)) {
      // Clear the empty shared dir so rename can take the slot (rename onto an
      // existing dir fails on Windows and on non-empty dirs everywhere).
      fs.rmSync(shared, { recursive: true, force: true });
      try {
        fs.renameSync(legacyDir, shared);            // same volume → atomic
      } catch {
        fs.cpSync(legacyDir, shared, { recursive: true }); // cross-volume → copy, leave legacy
      }
      fs.mkdirSync(shared, { recursive: true });     // ensure it exists post-move
    }
  } catch {
    /* migration is best-effort; the writable `shared` dir is still returned */
  }

  return shared;
}
