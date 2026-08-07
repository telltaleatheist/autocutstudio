// Pure interval / array math shared by the editor shell and its children.
// No Angular, no component state — every input is a parameter.

import { EditorSegment } from '../../../models/editor-manifest';
import { Cut } from './editor-types';

export const EPS = 1e-9;           // seconds; sub-frame slop for interval intersection

/** Sort + merge [lo,hi] ranges, coalescing any that overlap or touch. */
export function mergeRanges(ranges: { lo: number; hi: number }[]): { lo: number; hi: number }[] {
  if (ranges.length <= 1) return ranges;
  const sorted = [...ranges].sort((a, b) => a.lo - b.lo);
  const out: { lo: number; hi: number }[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = out[out.length - 1];
    const nx = sorted[i];
    if (nx.lo <= cur.hi + EPS) cur.hi = Math.max(cur.hi, nx.hi);
    else out.push({ ...nx });
  }
  return out;
}

/**
 * Merge a story's regions: sort by start and coalesce any that overlap or touch (within
 * EPS), so repeated drags onto the same story become clean disjoint spans. Sub-EPS slivers
 * are dropped. Pure — never mutates the input.
 */
export function mergeRegions(regions: { start: number; end: number }[]): { start: number; end: number }[] {
  const sorted = regions
    .filter(r => r.end - r.start > EPS)
    .map(r => ({ start: r.start, end: r.end }))
    .sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + EPS) {
      if (r.end > last.end) last.end = r.end;   // extend the open span
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/** Merge a cut list into sorted, non-overlapping order (adjacent frame ranges coalesce). */
export function mergeCuts(list: Cut[]): Cut[] {
  if (list.length === 0) return [];
  const sorted = [...list].sort((a, b) => a.startFrame - b.startFrame);
  const out: Cut[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = out[out.length - 1];
    const next = sorted[i];
    if (next.startFrame <= cur.endFrame) {
      cur.endFrame = Math.max(cur.endFrame, next.endFrame);
    } else {
      out.push({ ...next });
    }
  }
  return out;
}

/** Nearest value in a SORTED grid (binary search, then only the neighbours can be nearer). */
export function nearestBoundary(grid: number[], t: number): number {
  if (grid.length === 0) return t;
  let lo = 0, hi = grid.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (grid[mid] < t) lo = mid + 1; else hi = mid; }
  let best = grid[lo];
  for (const i of [lo - 1, lo + 1]) {
    if (i < 0 || i >= grid.length) continue;
    if (Math.abs(grid[i] - t) < Math.abs(best - t)) best = grid[i];
  }
  return best;
}

/**
 * Canonicalize a freshly built sequence: drop slivers, re-join entries that ended up adjacent in
 * ORIGINAL time as well as in playback order, and collapse a sequence that is once again plain
 * source order back to null. Without this the entry list only ever grows — every move fragments
 * it further, the rebuild walk is O(entries × cuts), and a sidecar would carry a `sequence` field
 * describing nothing.
 *
 * `dur` is the manifest's timeline duration — the full-span extent a single entry has to match to
 * collapse back to null.
 */
export function normalizeSequence(
  list: { start: number; end: number }[],
  dur: number,
): { start: number; end: number }[] | null {
  const out: { start: number; end: number }[] = [];
  for (const e of list) {
    if (e.end - e.start <= EPS) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last.end - e.start) <= EPS) last.end = e.end;
    else out.push({ start: e.start, end: e.end });
  }
  if (out.length === 0) return null;
  if (out.length === 1 && Math.abs(out[0].start) <= EPS && Math.abs(out[0].end - dur) <= EPS) {
    return null;
  }
  return out;
}

// ── Segment lookup (binary search over sorted segments) ─────────────────────
/** The segment of `arr` (sorted ascending by timelineStart) containing time `t`, or null. */
export function segmentAtIn(arr: EditorSegment[] | undefined, t: number): EditorSegment | null {
  if (!arr || arr.length === 0) return null;
  let lo = 0, hi = arr.length - 1, found: EditorSegment | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = arr[mid];
    if (s.timelineStart <= t) {
      // Candidate: the last segment whose start <= t. Keep searching right.
      if (t < s.timelineStart + s.duration) found = s;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // `found` was only set when t fell inside a segment. If the last start<=t segment
  // ended before t (a gap), found stays null — which is correct.
  return found;
}

/** ⌘-click (⌃-click on Windows/Linux) is the multi-pick modifier, in the story list and on the
 *  timeline ribbon alike. Accepting both keys costs nothing and avoids a platform check. */
export function isMultiPick(ev: MouseEvent): boolean {
  return ev.metaKey || ev.ctrlKey;
}

/** True when a keydown target is an editable field (input / textarea / contentEditable). */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
}
