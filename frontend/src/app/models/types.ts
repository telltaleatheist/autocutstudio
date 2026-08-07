// src/app/models/types.ts

export interface AudioSource {
  id: string;
  path: string;
  type: MediaSourceType | '';
  name: string;
  syncFix: boolean;
  applyDrift: boolean;
  isVideo?: boolean;  // True if this is a video file (cam, screen, game)
  // Continuation parts only: the gap, in seconds, between the END of the
  // previous part and the START of this one. Left null the gap is MEASURED
  // against the master by GCC-PHAT, which is the normal case; a number here
  // overrides that, for a part whose audio cannot be aligned (a lost feed).
  seamGapSeconds?: number | null;
}

export type AudioSourceType =
  | 'mic1'
  | 'mic2'
  | 'mic3'
  | 'mic4'
  | 'screen'
  | 'game'
  | 'soundEffects'
  | 'bluetooth'
  | 'mic1Sb'
  | 'mic2Sb'
  | 'mic3Sb'
  | 'mic4Sb'
  | 'screenSb'
  | 'desktopSb'
  | 'gameSb'
  | 'bluetoothSb'
  | 'soundEffectsSb';

export type VideoSourceType =
  | 'cam1'
  | 'cam2'
  | 'screenVideo'
  | 'gameVideo'
  // Continuation parts of a capture that was stopped and restarted mid-session.
  // They are spliced onto the base capture (with black filler across the gap
  // where nothing was recorded) before anything else looks at it, so the rest of
  // the pipeline still sees a single continuous file. Part 2 requires part 1;
  // part 3 requires part 2.
  | 'screenVideo2'
  | 'screenVideo3'
  | 'gameVideo2'
  | 'gameVideo3';

/** Continuation part types mapped to the backend source they extend, in order. */
export const VIDEO_CONTINUATION_PARTS: {
  [key: string]: { base: 'screen' | 'game'; part: number };
} = {
  screenVideo2: { base: 'screen', part: 2 },
  screenVideo3: { base: 'screen', part: 3 },
  gameVideo2: { base: 'game', part: 2 },
  gameVideo3: { base: 'game', part: 3 }
};

export type MediaSourceType = AudioSourceType | VideoSourceType;

export interface VideoSource {
  type: 'cam1' | 'cam2' | 'screen' | 'game';
  path: string;
}

export interface WorkflowOptions {
  masterVideo: string;
  audioSources: { [key: string]: string };
  audioSyncSettings: { [key: string]: boolean };
  videoSources?: { [key: string]: string };
  threshold?: string;
  xmlOptions?: string[];
  outputDir?: string;
}

export interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modified: Date;
}

export interface DependencyCheckResult {
  available: boolean;
  version?: string;
  path?: string;
  error?: string;
}

export interface AllDependenciesResult {
  python: DependencyCheckResult;
  ffmpeg: DependencyCheckResult;
  ffprobe: DependencyCheckResult;
  autoEditor: DependencyCheckResult;
  allAvailable: boolean;
}

export const AUDIO_SOURCE_LABELS: { [key in AudioSourceType]: string } = {
  mic1: 'Mic Audio 1',
  mic2: 'Mic Audio 2',
  mic3: 'Mic Audio 3',
  mic4: 'Mic Audio 4',
  screen: 'Screen Audio',
  game: 'Game Audio',
  soundEffects: 'Sound Effects',
  bluetooth: 'Bluetooth Audio',
  mic1Sb: 'Mic 1 (Soundboard)',
  mic2Sb: 'Mic 2 (Soundboard)',
  mic3Sb: 'Mic 3 (Soundboard)',
  mic4Sb: 'Mic 4 (Soundboard)',
  screenSb: 'Screen Audio (Soundboard)',
  desktopSb: 'Desktop Audio (Soundboard)',
  gameSb: 'Game Audio (Soundboard)',
  bluetoothSb: 'Bluetooth (Soundboard)',
  soundEffectsSb: 'Sound Effects (Soundboard)'
};

export const VIDEO_SOURCE_LABELS: { [key in VideoSourceType]: string } = {
  cam1: 'Camera 1 Video',
  cam2: 'Camera 2 Video',
  screenVideo: 'Screen Capture Video',
  gameVideo: 'Game Capture Video',
  screenVideo2: 'Screen Capture Video (part 2)',
  screenVideo3: 'Screen Capture Video (part 3)',
  gameVideo2: 'Game Capture Video (part 2)',
  gameVideo3: 'Game Capture Video (part 3)'
};

export const MEDIA_SOURCE_LABELS: { [key in MediaSourceType]: string } = {
  ...AUDIO_SOURCE_LABELS,
  ...VIDEO_SOURCE_LABELS
};

export const XML_OPTIONS = [
  { value: 'camSolo', label: 'CAM Solo', description: 'Single camera with mic audio' },
  { value: 'camDual', label: 'CAM Dual', description: 'Dual camera layout' },
  { value: 'gsSolo', label: 'GS Solo', description: 'Game share with single camera' },
  { value: 'gsDual', label: 'GS Dual', description: 'Game share with dual camera' },
  { value: 'ssbSolo', label: 'SSB Solo', description: 'Screen share big with single camera' },
  { value: 'ssbDual', label: 'SSB Dual', description: 'Screen share big with dual camera' }
];
