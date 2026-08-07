// Everything one frame of the timeline needs, and nothing else.
//
// The shell builds this once per rAF tick (`buildScene()`); the renderer only reads it. No
// Angular, no DOM refs, no component methods — the one exception is `storyRibbonPieces`, a
// closure over the shell's edited-time map, which exists so the ribbon keeps calling
// `editedRangesForOriginal` once per region per frame exactly as it does today (pre-flattening
// would change the call count and the order).

import { EditorSegment } from '../../../models/editor-manifest';
import { MoveDrag, TrackRow } from '../model/editor-types';

export interface TimelineScene {
  rows: TrackRow[];
  segsByTrack: ReadonlyMap<string, EditorSegment[]>;
  scrollOffset: number;
  pxPerSec: number;
  playheadTime: number;
  ribbonHeight: number;
  /** Blade boundaries already mapped through originalToEdited. */
  bladeEdited: number[];
  /** === allSelectionRanges() */
  selectionRanges: { lo: number; hi: number }[];
  /** selStart ?? selEnd, used only when `selectionRanges` is empty (the one-sided ruler flag). */
  pendingMark: number | null;
  marquee: { active: boolean; moved: boolean; start: number; end: number };
  moveDrag: MoveDrag | null;
  stories: { id: string; number: number; title: string; regions: { start: number; end: number }[] }[];
  storyRibbonPieces: (r: { start: number; end: number }) => { lo: number; hi: number }[];
  activeStoryId: string | null;
  mergePicked: ReadonlySet<string>;
  hasStories: boolean;
}
