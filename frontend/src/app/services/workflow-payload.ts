// src/app/services/workflow-payload.ts
import { AudioSource, VIDEO_CONTINUATION_PARTS } from '../models/types';

/**
 * The ONE place a workflow payload is assembled. Both entry points — the old workflow page
 * and the editor's project-setup modal — hand their raw UI state to buildWorkflowOptions and
 * send exactly what comes back, so the two surfaces cannot drift into producing different
 * payloads from the same session.
 *
 * Pure functions, no Angular: validation is RETURNED (never alerted, never logged and
 * swallowed) and an invalid spec yields `options: null` with the specific reason. The caller
 * decides how to show it.
 */

/** Manual per-source offsets. Null (the normal case) => full automatic alignment. */
export type AlignmentOverrides = {
  audio?: { [key: string]: { offsetSeconds: number; driftFactor?: number } };
  video?: { [key: string]: { offsetSeconds: number; driftFactor?: number } };
};

/** Everything the payload is derived from — the caller's UI state, nothing more. */
export interface WorkflowPayloadSpec {
  masterVideo: string;
  /** The media rows the user sees: audio and video, including continuation parts. */
  sources: AudioSource[];
  /**
   * Video paths chosen outside the rows (the workflow page's dedicated cam1/cam2/screen/game
   * block). Omitted => the empty four-key map that page has always sent, so both callers
   * produce the same payload shape.
   */
  videoSources?: { [key: string]: string };
  autoDuck: boolean;
  denoiseMics: boolean;
  /** The voice-separator asset gate: denoiseMics is only ever sent true when it is installed. */
  separatorInstalled: boolean;
  useDownloadedStream: boolean;
  alignmentOverrides: AlignmentOverrides | null;
}

/** The payload handed to ProcessingService.startWorkflow / measureAlignment. */
export interface WorkflowOptionsPayload {
  masterVideo: string;
  audioSources: { [key: string]: string };
  audioSyncSettings: { [key: string]: boolean };
  videoSources: { [key: string]: string };
  videoContinuations?: { [key: string]: string[] };
  videoSeamGaps?: { [key: string]: (number | null)[] };
  autoDuck: boolean;
  denoiseMics: boolean;
  useDownloadedStream: boolean;
  alignmentOverrides: AlignmentOverrides | null;
}

export interface WorkflowPayloadResult {
  /** Null whenever `errors` is non-empty — there is no half-valid payload. */
  options: WorkflowOptionsPayload | null;
  errors: string[];
}

/** The video source types the compound generators know, keyed by the row type that feeds them. */
const VIDEO_TYPE_MAP: { [key: string]: string } = {
  screenVideo: 'screen',
  gameVideo: 'game'
};

/**
 * Build the workflow payload, or report exactly what is wrong with the spec.
 *
 * Stops at the FIRST problem, as the workflow page always has: the checks are ordered from
 * "nothing to process" outwards, and a later check reading state an earlier one rejected
 * would only produce a second, derived complaint.
 */
export function buildWorkflowOptions(spec: WorkflowPayloadSpec): WorkflowPayloadResult {
  if (!spec.masterVideo) {
    return { options: null, errors: ['Please select a master video.'] };
  }

  if (spec.sources.length > 0) {
    const unassigned = spec.sources.filter(s => !s.type);
    if (unassigned.length > 0) {
      return { options: null, errors: ['Please assign types to all audio sources.'] };
    }
  }

  const audioSourcesObj: { [key: string]: string } = {};
  const audioSyncSettings: { [key: string]: boolean } = {};
  const videoSourcesObj: { [key: string]: string } = {};

  // Continuation parts of a restarted capture, collected per base source and
  // ordered by part number. Empty => ordinary single-file capture.
  const continuationRows: { [key: string]: { part: number; source: AudioSource }[] } = {};

  spec.sources.forEach(source => {
    if (source.type) {
      if (source.isVideo) {
        const continuation = VIDEO_CONTINUATION_PARTS[source.type];
        if (continuation) {
          (continuationRows[continuation.base] ||= []).push(
            { part: continuation.part, source });
          return;
        }
        // Map video source types (screenVideo/gameVideo -> screen/game for compound generators)
        const backendType = VIDEO_TYPE_MAP[source.type] || source.type;
        videoSourcesObj[backendType] = source.path;
      } else {
        // Audio source - send camelCase directly to Python
        audioSourcesObj[source.type] = source.path;
        audioSyncSettings[source.type] = source.syncFix || source.applyDrift;
      }
    }
  });

  // Merge video sources from both the dedicated videoSources object and the source rows
  const mergedVideoSources: { [key: string]: string } =
    { ...(spec.videoSources || { cam1: '', cam2: '', screen: '', game: '' }), ...videoSourcesObj };

  // Order the continuation parts and check the chain is complete. A part 3
  // with no part 2, or a part 2 with no base capture, would otherwise be
  // spliced in the wrong place or silently ignored.
  const videoContinuations: { [key: string]: string[] } = {};
  const videoSeamGaps: { [key: string]: (number | null)[] } = {};
  for (const [base, rows] of Object.entries(continuationRows)) {
    rows.sort((a, b) => a.part - b.part);
    if (!mergedVideoSources[base]) {
      return {
        options: null,
        errors: [`You added a continuation part for the ${base} capture, but no ` +
                 `base ${base} capture file. Add the first part too.`]
      };
    }
    const expected = rows.map((_, i) => i + 2);
    if (rows.some((r, i) => r.part !== expected[i])) {
      return {
        options: null,
        errors: [`The ${base} capture parts are not consecutive ` +
                 `(got ${rows.map(r => r.part).join(', ')}). ` +
                 `Part 3 needs a part 2.`]
      };
    }
    videoContinuations[base] = rows.map(r => r.source.path);
    const gaps = rows.map(r =>
      typeof r.source.seamGapSeconds === 'number' ? r.source.seamGapSeconds : null);
    if (gaps.some(g => g !== null)) {
      videoSeamGaps[base] = gaps;
    }
  }

  const options: WorkflowOptionsPayload = {
    masterVideo: spec.masterVideo,
    audioSources: audioSourcesObj,
    audioSyncSettings,
    videoSources: mergedVideoSources,
    // Absent when nothing was split, so an ordinary session's payload is
    // byte-identical to what it was before split captures existed.
    ...(Object.keys(videoContinuations).length ? { videoContinuations } : {}),
    ...(Object.keys(videoSeamGaps).length ? { videoSeamGaps } : {}),
    autoDuck: spec.autoDuck,
    denoiseMics: spec.separatorInstalled && spec.denoiseMics,
    useDownloadedStream: spec.useDownloadedStream,
    // Phase 1: carry manual overrides through untouched (null => full auto).
    alignmentOverrides: spec.alignmentOverrides
  };

  return { options, errors: [] };
}
