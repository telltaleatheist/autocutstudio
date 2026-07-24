/**
 * Asset catalog — the list of downloadable components and where to get them.
 *
 * Hardcoded (no manifest server): version bumps happen here. After building +
 * uploading an artifact with `scripts/publish-assets.mjs`, paste the printed
 * sha256 + bytes into the matching artifact below.
 *
 * Artifacts are hosted on the project's own GitHub releases under a single tag
 * (RELEASE_TAG). The Python env is app-specific; ffmpeg/ffprobe and models are
 * generic and land in the cross-app OwenMorgan shared dir, so if another app
 * already downloaded them this app reuses them (see asset-manager).
 */

import type { AssetComponent, Platform, Arch } from './asset-types';

export const RELEASE_REPO = 'telltaleatheist/autocutstudio';
export const RELEASE_TAG = 'assets-v1';
const BASE = `https://github.com/${RELEASE_REPO}/releases/download/${RELEASE_TAG}`;

const CATALOG: AssetComponent[] = [
  // ── ffmpeg + ffprobe (one archive, two binaries) ───────────────────────────
  {
    id: 'ffmpeg-tools',
    name: 'FFmpeg + FFprobe',
    description: 'Audio/video processing tools required for all editing workflows.',
    category: 'managed-bins',
    required: true,
    version: '7.1.1',
    binaries: ['ffmpeg', 'ffprobe'],
    artifacts: [
      {
        platform: 'darwin',
        arch: 'arm64',
        kind: 'archive',
        url: `${BASE}/ffmpeg-tools-darwin-arm64.tar.gz`,
        sha256: '81a02701d5b71d3c891da9a90e2e813825fb2c0b15d832db0b90b7417bf0bf7e',
        bytes: 31216095,
      },
      {
        platform: 'darwin',
        arch: 'x64',
        kind: 'archive',
        url: `${BASE}/ffmpeg-tools-darwin-x64.tar.gz`,
        sha256: 'a14905a31eac2de157f65ab8c13da4a949ecca0f08621ed918accb104725a05e',
        bytes: 53479928,
      },
      {
        platform: 'win32',
        arch: 'x64',
        kind: 'archive',
        url: `${BASE}/ffmpeg-tools-win32-x64.zip`,
        sha256: '',
        bytes: 0,
      },
      {
        platform: 'linux',
        arch: 'x64',
        kind: 'archive',
        url: `${BASE}/ffmpeg-tools-linux-x64.tar.gz`,
        sha256: '',
        bytes: 0,
      },
    ],
  },

  // ── Python runtime (conda-pack tarball) ────────────────────────────────────
  {
    id: 'python-env',
    name: 'Python runtime',
    description: 'Bundled Python environment with all processing dependencies.',
    category: 'runtime',
    required: true,
    installSubdir: 'autocutstudio-env',
    version: '2026.06.19',
    entry: process.platform === 'win32' ? 'python.exe' : 'bin/python3',
    postInstall: 'conda-unpack',
    artifacts: [
      {
        platform: 'darwin',
        arch: 'arm64',
        kind: 'archive',
        url: `${BASE}/python-env-darwin-arm64.tar.gz`,
        sha256: '5bf73d8a077516e57d75f4e816fc62bb49437042cc3b45ba4997f0ae0ad4c7fb',
        bytes: 236197403,
      },
      {
        platform: 'darwin',
        arch: 'x64',
        kind: 'archive',
        url: `${BASE}/python-env-darwin-x64.tar.gz`,
        sha256: 'bf2b4fb34c3367a6a74743e3264222a71d6684139623e25333eddc275dcda99c',
        bytes: 163363809,
      },
      {
        platform: 'win32',
        arch: 'x64',
        kind: 'archive',
        url: `${BASE}/python-env-win32-x64.tar.gz`,
        sha256: '',
        bytes: 0,
      },
      {
        platform: 'linux',
        arch: 'x64',
        kind: 'archive',
        url: `${BASE}/python-env-linux-x64.tar.gz`,
        sha256: '',
        bytes: 0,
      },
    ],
  },

  // ── Voice isolation (audio-separator conda env, optional) ──────────────────
  // Chunked mel-band-roformer separator used to isolate the speaker's voice on
  // mic1/mic2 before alignment. Conda-packed like python-env (postInstall:
  // conda-unpack). The separator model is bundled INSIDE the env at
  // audio-separator-models/vocals_mel_band_roformer.ckpt.
  {
    id: 'voice-separator-env',
    name: 'Voice isolation',
    description: 'Optional voice-isolation engine that removes background noise from mic 1 / mic 2 before alignment.',
    category: 'runtime',
    required: false,
    installSubdir: 'voice-separator-env',
    version: '2026.07.17',
    entry: process.platform === 'win32' ? 'python.exe' : 'bin/python3',
    postInstall: 'conda-unpack',
    artifacts: [
      {
        platform: 'darwin',
        arch: 'arm64',
        kind: 'archive',
        url: `${BASE}/autocut-separator-env-macos-arm64.tar.gz`,
        sha256: '736c98213173c86d26b9f3669a0eab332ee8464cd83a1c77ea2dcc9627f9d3e8',
        bytes: 1214161322,
      },
      // TODO Intel (osx-64): artifact not built/uploaded yet. Left unpublished
      // (sha256:'' , bytes:0) so isPublished() is false and the app treats voice
      // isolation as not-downloadable on Intel Macs until this is filled in.
      {
        platform: 'darwin',
        arch: 'x64',
        kind: 'archive',
        url: `${BASE}/autocut-separator-env-macos-x64.tar.gz`,
        sha256: '',
        bytes: 0,
      },
    ],
  },

  // ── Whisper base model (REQUIRED; the app's default transcription model) ────
  // Installed by the first-launch setup screen — deliberately NOT a user choice of
  // sizes. base is the default: small (~148 MB) and fast, so it downloads quickly
  // and transcribes cheaply while iterating. (It does NOT reliably surface fillers
  // like um/uh — that's a training property of Whisper at every size — so a heavier
  // model can be swapped back in here later if verbatimness becomes the priority.)
  // The transcript sidecar records which model actually ran.
  {
    id: 'whisper-base',
    name: 'Whisper speech-recognition model',
    description: 'Speech-to-text model used for transcription and story transcripts.',
    category: 'models',
    required: true,
    installSubdir: 'whisper',
    version: 'base',
    entry: 'ggml-base.bin',
    artifacts: [
      // Cross-platform single file — same model on every OS. sha256/bytes verified
      // against the file downloaded from this exact URL.
      ...(['darwin', 'win32', 'linux'] as Platform[]).flatMap((platform) =>
        (['arm64', 'x64'] as Arch[]).map((arch) => ({
          platform,
          arch,
          kind: 'file' as const,
          url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
          sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
          bytes: 147951465,
          fileName: 'ggml-base.bin',
        }))
      ),
    ],
  },
];

export function getCatalog(): AssetComponent[] {
  return CATALOG;
}

export function getComponent(id: string): AssetComponent | undefined {
  return CATALOG.find((c) => c.id === id);
}
