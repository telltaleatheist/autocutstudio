// electron/services/metadata/bridges/runtime-paths.ts
/**
 * Runtime binary paths for the metadata pipeline's Whisper transcription.
 *
 * Ported from ContentStudio's electron/lib/bridges/runtime-paths.ts, but the BODY is
 * rewritten: ContentStudio resolves binaries through its own component-manager (a
 * download-on-demand catalog with a user-selectable Whisper model). AutoCutStudio already
 * has ONE authority on where binaries live — `BinaryResolver` — and it throws with
 * actionable install messages rather than guessing. Keeping ContentStudio's resolver
 * alongside it would mean two answers to "where is ffmpeg", which is exactly the kind of
 * silent divergence that makes a packaged build fail in a way dev never reproduces.
 *
 * So this file is a THIN ADAPTER: it keeps the shape the ported bridges/whisper.service
 * import (`getRuntimePaths()`, `verifyBinary()`, ...) and answers every question from
 * BinaryResolver.
 *
 * The one real difference in behaviour: ContentStudio lets the user pick a Whisper model
 * size and stores it in settings. AutoCutStudio's resolver PICKS the model itself
 * (`getWhisperModelPath()` walks base → small → medium → large-v3 and logs which it used).
 * `getSelectedWhisperModel()` therefore reports what the resolver actually resolved rather
 * than a stored preference — a settings value that disagreed with the file on disk would
 * make the transcript sidecar's provenance a lie.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as log from 'electron-log';
import { BinaryResolver } from '../../binary-resolver';

export interface RuntimePaths {
  ffmpeg: string;
  ffprobe: string;
  whisper: string;
  whisperModelsDir: string;
}

// One resolver for the whole process. BinaryResolver caches its lookups internally and
// several of them shell out (`-h`, `file`) to prove a binary actually RUNS; constructing
// a fresh one per transcription would pay that cost on every video.
let resolver: BinaryResolver | null = null;
function getResolver(): BinaryResolver {
  if (!resolver) resolver = new BinaryResolver();
  return resolver;
}

/**
 * Resolve every binary the transcription path needs.
 *
 * Deliberately NOT lazy per-field: each getter throws with its own actionable message
 * ("install it from Settings → Assets"), and the caller (WhisperService's constructor)
 * wants to fail before it starts a job rather than half-way through one.
 */
export function getRuntimePaths(): RuntimePaths {
  const r = getResolver();
  const modelPath = r.getWhisperModelPath();
  return {
    ffmpeg: r.getFfmpegPath(),
    ffprobe: r.getFfprobePath(),
    whisper: r.getWhisperCliPath(),
    // WhisperBridge composes `<modelsDir>/ggml-<name>.bin`, but BinaryResolver hands back a
    // resolved FILE. Taking its directory keeps the bridge's contract intact and means the
    // model the bridge loads is byte-for-byte the one the resolver vouched for.
    whisperModelsDir: path.dirname(modelPath),
  };
}

/**
 * The Whisper model the resolver actually settled on, derived from the resolved filename
 * (`ggml-base.bin` -> `base`). Reported rather than configured — see the file header.
 */
export function getSelectedWhisperModel(): string {
  const modelPath = getResolver().getWhisperModelPath();
  const base = path.basename(modelPath, '.bin');
  return base.startsWith('ggml-') ? base.slice('ggml-'.length) : base;
}

/**
 * macOS only: the directory whisper-cli's ggml dylibs sit in, exported as
 * DYLD_LIBRARY_PATH by WhisperBridge. Without it a bundled whisper-cli that is present and
 * executable still dies at load time with a dyld error that names no cause.
 */
export function getWhisperLibraryPath(): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  return path.dirname(getResolver().getWhisperCliPath());
}

/**
 * Assert a resolved binary exists. Architecture is NOT re-checked here: BinaryResolver
 * already does that (`assertBinaryArch`) and additionally proves the binary runs, which is
 * strictly stronger. Re-running `file` on every construction would only add latency and a
 * second, weaker opinion.
 */
export function verifyBinary(binaryPath: string, name: string): void {
  if (!binaryPath || !fs.existsSync(binaryPath)) {
    throw new Error(`${name} binary not found at: ${binaryPath}`);
  }
  log.info(`[RuntimePaths] ${name}: ${binaryPath}`);
}
