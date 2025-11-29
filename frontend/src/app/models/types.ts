// src/app/models/types.ts

export interface AudioSource {
  id: string;
  path: string;
  type: MediaSourceType | '';
  name: string;
  syncFix: boolean;
  applyDrift: boolean;
  isVideo?: boolean;  // True if this is a video file (cam, screen, game)
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
  | 'gameVideo';

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
  gameVideo: 'Game Capture Video'
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
