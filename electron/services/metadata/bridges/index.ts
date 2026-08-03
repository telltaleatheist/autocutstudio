// electron/services/metadata/bridges/index.ts
/**
 * Process wrappers for the external binaries the metadata pipeline shells out to.
 *
 * Ported from ContentStudio's electron/lib/bridges/. The three bridge files are verbatim —
 * they take explicit binary paths in their constructors, so they carried over untouched.
 * `runtime-paths.ts` is the rewritten part (see its header): it answers "where is ffmpeg /
 * whisper / the model" from AutoCutStudio's BinaryResolver instead of ContentStudio's
 * component-manager.
 *
 * They live under services/metadata/ rather than a top-level lib/ because transcription for
 * metadata generation is currently their only caller — AutoCutStudio's other transcription
 * path goes through PythonService. If a second caller appears, lift this directory.
 */

export {
  getRuntimePaths,
  verifyBinary,
  getWhisperLibraryPath,
  getSelectedWhisperModel,
  type RuntimePaths,
} from './runtime-paths';

export {
  FfmpegBridge,
  type FfmpegProgress,
  type FfmpegProcessInfo,
  type FfmpegResult,
} from './ffmpeg-bridge';

export {
  FfprobeBridge,
  type StreamInfo,
  type FormatInfo,
  type ProbeResult,
  type MediaInfo,
} from './ffprobe-bridge';

export {
  WhisperBridge,
  type WhisperProgress,
  type WhisperProcessInfo,
  type WhisperResult,
  type WhisperConfig,
} from './whisper-bridge';
