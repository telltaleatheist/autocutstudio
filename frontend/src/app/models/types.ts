// src/app/models/types.ts

export interface AudioSource {
  id: string;
  path: string;
  type: AudioSourceType | '';
  name: string;
  syncFix: boolean;
  applyDrift: boolean;
}

export type AudioSourceType =
  | 'mic1'
  | 'mic2'
  | 'mic3'
  | 'mic4'
  | 'screen'
  | 'game'
  | 'soundEffects'
  | 'bluetooth';

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
  bluetooth: 'Bluetooth Audio'
};

export const VIDEO_SOURCE_LABELS = {
  cam1: 'Camera 1',
  cam2: 'Camera 2',
  screen: 'Screen Capture',
  game: 'Game Capture'
};

export const XML_OPTIONS = [
  { value: 'camSolo', label: 'CAM Solo', description: 'Single camera with mic audio' },
  { value: 'camDual', label: 'CAM Dual', description: 'Dual camera layout' },
  { value: 'gsSolo', label: 'GS Solo', description: 'Game share with single camera' },
  { value: 'gsDual', label: 'GS Dual', description: 'Game share with dual camera' },
  { value: 'ssbSolo', label: 'SSB Solo', description: 'Screen share big with single camera' },
  { value: 'ssbDual', label: 'SSB Dual', description: 'Screen share big with dual camera' },
  { value: 'masterSolo', label: 'Master SOLO', description: 'Complete solo project' },
  { value: 'masterDC', label: 'Master DC', description: 'Complete dual camera project' }
];
