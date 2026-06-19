/**
 * Asset/download system — shared contract for AutoCutStudio.
 *
 * AutoCut downloads its toolchain (ffmpeg/ffprobe, the Python runtime, optional
 * whisper model) from GitHub releases into the per-machine OwenMorgan shared
 * location on first run, so the assets are downloaded once and reused across all
 * OwenMorgan apps. See electron/shared-paths.ts.
 *
 * Adapted from the Minutes/BookForge component system, simplified (no GPU/CUDA
 * matrix): one artifact per platform+arch.
 */

export type Platform = 'win32' | 'darwin' | 'linux';
export type Arch = 'x64' | 'arm64';

/** How an artifact is materialized on disk. */
export type ArtifactKind =
  | 'file'      // a single raw file (e.g. a .bin model) placed as-is
  | 'archive';  // a .zip/.tar.gz extracted into the install dir

/** Optional post-extract step run inside the install dir. */
export type PostInstall = 'conda-unpack';

/** Shared-dir category (sub-directory under the OwenMorgan base). */
export type AssetCategory = 'managed-bins' | 'models' | 'runtime';

export interface AssetArtifact {
  platform: Platform;
  arch: Arch;
  kind: ArtifactKind;
  url: string;
  /** sha256 for integrity. Empty allowed; when empty, verify is skipped. */
  sha256?: string;
  /** Download size in bytes (UI + integrity guard). */
  bytes: number;
  /** 'file': filename to save as (defaults to the URL basename). */
  fileName?: string;
}

export interface AssetComponent {
  id: string;                  // e.g. 'ffmpeg-tools', 'python-env', 'whisper-base'
  name: string;                // display name
  description: string;         // one or two lines for the UI
  category: AssetCategory;
  /** Required for the app to function — installed on first run before the app is usable. */
  required?: boolean;
  /** Sub-dir name under <shared>/<category>/. Defaults to `id`. */
  installSubdir?: string;
  /** Version/tag this entry points at. Bump to force re-download. */
  version?: string;
  /** Executables this component provides, resolved by name within the install dir.
   *  (archive components, e.g. ffmpeg-tools → ['ffmpeg', 'ffprobe']) */
  binaries?: string[];
  /** For single-file/extracted components, the entry path relative to the install
   *  dir that consumers resolve to USE it (model file, or python interpreter). */
  entry?: string;
  /** Optional post-extract step (e.g. conda-unpack for the Python env). */
  postInstall?: PostInstall;
  artifacts: AssetArtifact[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Installed record — persisted to <shared>/autocutstudio/installed.json.
// NOTE: we store category + subdir + version, NOT absolute paths. Resolution
// reconstructs paths against the CURRENT shared base so a relocated or
// fallback store still resolves (shared-paths rule #4).
// ─────────────────────────────────────────────────────────────────────────────

export interface InstalledRecord {
  id: string;
  version?: string;
  category: AssetCategory;
  /** Sub-dir name under the category dir (component.installSubdir || id). */
  subdir: string;
  sha256?: string;
  bytes?: number;
  installedAt: string;
}

export interface InstalledState {
  components: Record<string, InstalledRecord>;
}

export type ComponentState = 'installed' | 'available' | 'installing' | 'error';

export interface ComponentStatus {
  id: string;
  name: string;
  description: string;
  required: boolean;
  state: ComponentState;
  /** True when a published artifact exists for this platform (or it's already
   *  installed). Unpublished catalog placeholders are not installable yet. */
  installable: boolean;
  sizeBytes: number;
  version?: string;
  installed?: InstalledRecord;
}

export type InstallPhase =
  | 'resolve'
  | 'download'
  | 'verify'
  | 'extract'
  | 'postinstall'
  | 'done'
  | 'error';

export interface InstallProgress {
  id: string;
  phase: InstallPhase;
  /** 0–100 within the current phase. */
  pct: number;
  receivedBytes?: number;
  totalBytes?: number;
  message?: string;
}

export interface InstallResult {
  id: string;
  ok: boolean;
  record?: InstalledRecord;
  error?: string;
}
