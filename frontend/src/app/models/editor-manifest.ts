// Timeline-editor manifest — the single data contract produced by
// cli/editor_manifest.py and consumed by the editor component. All times are float
// seconds on the master-hybrid timeline; `sourceStart` is seconds into the media FILE.
// See the shared contract ("Manifest JSON"). This mirrors the Python output verbatim;
// the compound-clip structure is flattened away by Python and never surfaces here.

export interface EditorTrack {
  id: string;
  label: string;
  kind: 'video' | 'audio';
}

export interface EditorSegment {
  trackId: string;
  timelineStart: number; // seconds on the timeline
  duration: number;      // seconds
  file: string;          // absolute POSIX path to the media file
  sourceStart: number;   // seconds into the media FILE
  label: string;
}

export interface EditorManifest {
  schemaVersion: number;
  session: string;
  frameSeconds: number;   // e.g. 1001/30000 (29.97 NDF)
  timelineDuration: number;
  tracks: EditorTrack[];
  segments: EditorSegment[];
}
