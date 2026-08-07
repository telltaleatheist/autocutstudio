// Interfaces and type aliases shared across the editor shell and its children.
// Types only — no logic, no Angular. Moved verbatim out of editor.component.ts.

import { EditorTrack } from '../../../models/editor-manifest';

export interface Peaks { min: number[]; max: number[]; }

/**
 * Transcript sidecar (`<session>_transcript.json`). Words carry ORIGINAL timeline
 * coordinates (the v1 manifest time base, pre-user-cuts) — the same base the cut list uses,
 * so the frontend maps a word onto the current edited timeline through originalToEdited().
 */
export interface TranscriptWord {
  track: string;
  text: string;
  timelineStart: number;   // ORIGINAL seconds
  timelineEnd: number;     // ORIGINAL seconds
  fileStart: number;
  fileEnd: number;
  group: number;           // index of the containing flattened leaf segment on that file
  prob?: number;
}
export interface TranscriptTrack { id: string; label: string; file: string; }
export interface Transcript {
  schemaVersion: number;
  session: string;
  model: string;
  calibration: string;
  frameSeconds: number;
  tracks: TranscriptTrack[];
  words: TranscriptWord[];
}
/**
 * One rendered transcript block = every word sharing a (track, leaf-segment group) key — i.e.
 * a single timeline clip's worth of speech on one track. Times are ORIGINAL seconds.
 */
export interface TranscriptGroup {
  trackId: string;
  label: string;
  color: string;
  text: string;
  originalStart: number;   // min word timelineStart
  originalEnd: number;     // max word timelineEnd
}
/** A visible group with its cut-aware edited-timeline timecode (recomputed when cuts change). */
export interface TranscriptGroupView {
  label: string;
  color: string;
  text: string;
  originalStart: number;   // min word timelineStart (ORIGINAL seconds) — selection lo + seek target
  originalEnd: number;     // max word timelineEnd (ORIGINAL seconds) — selection hi
  editedStart: number;     // originalStart mapped through cuts (EDITED seconds) — karaoke follow
  editedEnd: number;       // originalEnd mapped through cuts (EDITED seconds)
  timecode: string;
}
/** Transcript pane lifecycle: button / progress+cancel / preview / verbatim error. */
export type TranscriptState = 'none' | 'running' | 'ready' | 'error';

/**
 * A recent session row, shared byte-for-byte with the launcher via the
 * 'editor.recentSessions' localStorage key. name = filename minus _compounds.zip.
 */
export interface RecentSession {
  zipPath: string;
  name: string;
  lastOpened: string; // ISO date
}

/** Timeline pointer tool: Arrow (scrub/select) or Blade (drop section boundaries). */
export type ToolMode = 'select' | 'blade' | 'story';

/**
 * A cut is a half-open FRAME range in ORIGINAL timeline coordinates (the manifest's time
 * base, before any edits). 0 <= startFrame < endFrame. Cut lists are kept sorted ascending
 * and non-overlapping (adjacent cuts merged). This is the single source of edit truth.
 */
export interface Cut { startFrame: number; endFrame: number; }

/**
 * A user-marked "story" as one or more disjoint spans (`regions`) in ORIGINAL timeline
 * seconds. A session covers ~5 stories; on export the fcpxml is split into one project per
 * story (that story's regions, minus the cuts, collapsed to 0). Stories are built in Story
 * Mode: each drag paints a region into the ACTIVE story, or — with none active — starts a
 * brand-new story (so consecutive drags make separate stories; to accumulate regions the
 * user clicks a story to make it active first). `number` is a user-facing ordering (auto =
 * max existing + 1, editable) that orders the exported projects. Not persisted across
 * sessions (v1); reset on session re-init.
 */
export interface Story {
  id: string;
  number: number;
  title: string;
  regions: { start: number; end: number }[];
  /**
   * The chapter markers INSIDE this story, in ORIGINAL seconds — the pre-consolidation tier the
   * analyzer merged to build it. Retained but NOT yet consumed: each story becomes its own YouTube
   * upload, which wants chapter markers in the description, and the eventual fine-tuned title
   * model conditions on them. Absent on hand-drawn stories (nothing analyzed them).
   *
   * Two things must happen before these can be written into a description, neither done here:
   * map through the cuts (the upload is the EDITED timeline) and rebase to the story's own start
   * (`storyLocalTime` does both). YouTube also needs 3+ markers, the first at 0:00.
   */
  chapters?: StoryChapter[];
  /**
   * Fingerprint of the regions `chapters` was derived from — see `regionFingerprint`. Chapters
   * are STALE whenever this does not equal the fingerprint of the story's regions right now.
   *
   * ABSENT means provisional: chapters that came from a whole-recording run or from a parent
   * story's split describe a span that was cut at a different cadence and before the user drew
   * this boundary, so they are markers worth keeping but are not this story's chapter layer. Only
   * a per-story derivation (run 2, consolidation off, scoped to exactly these regions) stamps it.
   */
  chaptersFrom?: string;
  /**
   * The user typed this title. Auto-titling then leaves it alone.
   *
   * The workflow puts naming BETWEEN the run that finds story boundaries and the run that
   * chapters and titles each story — the user merges, reorders and names, then asks for the rest.
   * Without this flag that second run overwrites every name they just typed, silently and with no
   * undo, which is the worst possible way to lose work.
   */
  titleTouched?: boolean;
  /**
   * Cached chapter-split analysis so reopening Split is instant and reworkable without re-running
   * the model. `regions` is the span that was ANALYZED (the re-apply intersection basis, which may
   * differ from `regions` above once a split has been applied); `chapters` the detected list;
   * `assign`/`buckets` the last modal layout to restore; `childIds` the stories the last Apply
   * created (deleted + recreated on re-apply so rework never duplicates). Off the export payload.
   */
  split?: StorySplitCache;
}

/** A chapter marker inside a story. ORIGINAL seconds, same frame as `Story.regions`. */
export interface StoryChapter {
  startSeconds: number;
  endSeconds: number;
  label: string;
  /**
   * One or two description-grade sentences from the same naming call as `label` — names, claims,
   * outcomes, the host's framing. This, not the 4-8 word label, is what a titling handoff sends
   * as the subject line: the headline model was trained on real video descriptions (60–2200
   * chars of prose) and terse labels starve it. Absent on chapters derived before this field
   * existed — the send path treats those as needing re-derivation.
   */
  detail?: string;
  /**
   * This start was placed from the raw junction, not a mapped quote — accurate to ±45 s instead of
   * the ~5 s the method targets. Shown in the story list because it is otherwise invisible: the
   * description looks identical either way, and the user only finds out by clicking the marker in
   * a published video and landing half a minute off.
   */
  startApprox?: boolean;
}

export interface StorySplitCache {
  regions: { start: number; end: number }[];
  // `subChapters` rides along so a cached reopen still carries the fine tier into Apply — without
  // it, reopening a cached split and re-applying would silently drop the markers.
  chapters: { index: number; startSeconds: number; endSeconds: number; label: string; subChapters?: StoryChapter[] }[];
  assign: number[];
  // `touched` = the user typed this bucket's title in the modal. It becomes the resulting story's
  // `titleTouched`, so a name given here survives auto-titling exactly like one typed in the list.
  buckets: { title: string; touched?: boolean }[];
  childIds: string[];
}

/**
 * One kept interval of the timeline after cuts are applied. `os`/`oe` are the interval's
 * bounds in ORIGINAL seconds; `es`/`ee` are the same span mapped into EDITED seconds (a span is
 * only ever relocated, never scaled, so ee - es === oe - os). `seq` is the index of the SEQUENCE
 * entry it was carved out of — how a selection in edited time is resolved back to the entries a
 * move has to lift.
 *
 * The list is NOT necessarily monotonic in both domains any more: once footage is reordered,
 * original order and edited order diverge. Hence TWO indexes over the SAME objects —
 * `keptBySequence` (ascending `es`, i.e. playback order, drives editedToOriginal) and
 * `keptByOriginal` (ascending `os`, drives originalToEdited). Both are binary-searched; these run
 * per playback frame and per drawn clip, so neither may degrade to a scan.
 */
export interface KeptInterval { os: number; oe: number; es: number; ee: number; seq: number; }

/** One undoable edit state. See editSnapshot() for why `sequence` has to ride along. */
export interface EditSnapshot {
  cuts: Cut[];
  blades: number[];
  sequence: { start: number; end: number }[] | null;
}

/**
 * One row of the activity dock's story-analysis queue. Index 0 is the story being worked on now;
 * everything after it is waiting its turn, in the order the run will reach it. A finished row is
 * REMOVED, not marked done — the dock shows what is left, not a history.
 */
export interface ActivityEntry {
  id: string;
  label: string;
  state: 'running' | 'pending';
}

/** Vertical layout of a track lane inside the canvas (CSS px, canvas-local). */
export interface TrackRow {
  track: EditorTrack;
  top: number;
  height: number;
}

/** In-flight "move this footage somewhere else" drag — see `EditorComponent.moveDrag`. */
export interface MoveDrag {
  ranges: { lo: number; hi: number }[];
  grabTime: number;                    // EDITED seconds under the cursor at mousedown
  dropAt: number;                      // snapped insertion point (EDITED seconds)
  boundaries: number[];
  moved: boolean;
}
