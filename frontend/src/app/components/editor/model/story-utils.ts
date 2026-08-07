// Pure story-shape helpers: display ordering, region fingerprints, chapter bookkeeping.
// No Angular, no component state.

import { Story, StoryChapter } from './editor-types';
import { EPS, mergeRegions } from './editor-math';
import { cleanChapterLabel } from './editor-format';

// Stable, distinct color per story NUMBER (cycled). Dark FCP-friendly hues.
export const STORY_COLORS = ['#e8a33d', '#4a9eff', '#7bc98f', '#c98fd6', '#d67b7b', '#7bd6cf', '#e0c650', '#9a8ff0'];

/** Stable, distinct color for a story NUMBER (palette cycled; safe for any integer). */
export function storyColor(n: number): string {
  const len = STORY_COLORS.length;
  const i = (((Math.round(n) - 1) % len) + len) % len;
  return STORY_COLORS[i];
}

/**
 * Stories in export/project order (number ascending, creation order breaking ties), each
 * with its regions merged (overlapping/adjacent spans a user painted in separate drags
 * collapsed into one) and carrying its `id` so the ribbon/strip can flag the active story.
 * Internal — resolveStoryRegions() strips the id for the export payload. PURE.
 */
export function storiesForDisplay(
  stories: Story[],
): { id: string; number: number; title: string; regions: { start: number; end: number }[] }[] {
  return stories
    .map((s, i) => ({ i, id: s.id, number: s.number, title: s.title, regions: mergeRegions(s.regions) }))
    .sort((a, b) => (a.number - b.number) || (a.i - b.i))
    .map(({ id, number, title, regions }) => ({ id, number, title, regions }));
}

/** True when a story has no regions (nothing to export). */
export function isStoryEmpty(story: Story): boolean {
  return mergeRegions(story.regions).length === 0;
}

/**
 * Fingerprint of a set of regions — the identity of the SPAN a story's chapters were derived
 * from. Stored on the story as `chaptersFrom`; a mismatch against the story's regions right now
 * is what "stale" means.
 *
 * This is a fingerprint and not an invalidate-on-edit call for one reason: regions are mutated
 * in a dozen places — the ribbon edge drag, Split ▸ Apply, merge, story delete, the timeline
 * move, auto-split — and every new one of those is another site that has to REMEMBER to
 * invalidate. That is the thing that gets forgotten quietly, and forgetting it leaves chapter
 * markers pointing at content the upload no longer contains. Comparing a fingerprint makes
 * staleness derived, so it cannot be forgotten; there are deliberately no invalidation calls at
 * the mutation sites.
 *
 * Merged and sorted first, so a span painted in two touching drags, or in the other order,
 * fingerprints identically to the same span painted in one. Rounded to milliseconds because
 * region edges are arithmetic results and land an ULP either side of where they started —
 * float noise must never read as a redrawn story. `r1:` is the format's own version: change the
 * rounding or the layout below and every stored fingerprint must stop matching rather than be
 * compared against strings built by different rules.
 */
export function regionFingerprint(regions: { start: number; end: number }[]): string {
  return 'r1:' + mergeRegions(regions)
    .map(r => `${r.start.toFixed(3)}-${r.end.toFixed(3)}`)
    .join(',');
}

/**
 * Where a story's chapters stand against its regions RIGHT NOW.
 *
 *   'fresh' — derived for exactly these regions, per story, with consolidation off.
 *   'stale' — chapters exist but describe a different span, or were derived at whole-recording
 *             cadence (provisional, `chaptersFrom` unset). Usable, never trusted; re-derived on
 *             the next demand.
 *   'none'  — nothing to use. Fewer than two markers is nothing a description can carry, which
 *             is why the floor is 2 rather than 1.
 */
export function storyChapterState(story: Story): 'fresh' | 'stale' | 'none' {
  if ((story.chapters?.length ?? 0) < 2) return 'none';
  return story.chaptersFrom && story.chaptersFrom === regionFingerprint(story.regions)
    ? 'fresh' : 'stale';
}

/**
 * How many of a story's chapter starts are ±45 s guesses rather than mapped quotes. Surfaced in
 * the story list because nothing else can show it: an approximate start produces a description
 * line that looks exactly like a good one, and the user finds out by clicking a published marker
 * and landing half a minute into the wrong thing.
 */
export function storyApproxChapters(story: Story): number {
  return (story.chapters || []).filter(c => c.startApprox).length;
}

/**
 * The ONLY writer of `story.chapters`. Chapters and the span they came from are set together so
 * they cannot drift apart — a list stamped by one code path and replaced by another is a list
 * that lies about being fresh.
 *
 * `from` is the fingerprint to stamp: pass the one taken BEFORE a long derivation (regions can
 * move while hundreds of model calls run, and stamping the current regions afterwards would
 * mark chapters fresh for a span they never saw), or `null` for provisional chapters that must
 * always read stale. Fewer than two markers clears both fields.
 */
export function setStoryChapters(story: Story, chapters: StoryChapter[] | undefined, from?: string | null): void {
  if (!chapters || chapters.length < 2) {
    delete story.chapters;
    delete story.chaptersFrom;
    return;
  }
  story.chapters = chapters;
  const stamp = from === undefined ? regionFingerprint(story.regions) : from;
  if (stamp) story.chaptersFrom = stamp; else delete story.chaptersFrom;
}

/**
 * Normalize an analyzer sub-chapter list into a story's retained markers. A single entry means
 * the chapter was never merged, so there is no internal structure to keep — returning undefined
 * there keeps "has chapters" honest instead of storing a marker list of one that no description
 * could use.
 */
export function toStoryChapters(subChapters?: StoryChapter[]): StoryChapter[] | undefined {
  if (!subChapters || subChapters.length < 2) return undefined;
  return subChapters
    .map(c => ({
      startSeconds: c.startSeconds, endSeconds: c.endSeconds, label: cleanChapterLabel(c.label),
      ...((c.detail || '').trim() ? { detail: c.detail!.trim() } : {}),
      ...(c.startApprox ? { startApprox: true } : {}),
    }))
    .sort((a, b) => a.startSeconds - b.startSeconds);
}

/**
 * The retained markers overlapping a set of ORIGINAL-second regions, clamped to them. Used when
 * a split hands part of an analyzed span to a different story: a marker outside the regions that
 * story actually kept would point at content the upload does not contain.
 */
export function clipStoryChapters(chapters: StoryChapter[] | undefined, regions: { start: number; end: number }[]): StoryChapter[] | undefined {
  if (!chapters?.length || !regions.length) return undefined;
  const out: StoryChapter[] = [];
  for (const c of chapters) {
    for (const r of regions) {
      const lo = Math.max(r.start, c.startSeconds);
      const hi = Math.min(r.end, c.endSeconds);
      // The approximate-placement flag only survives when the START is the one that was placed.
      // A marker clipped forward to a region edge starts where the user drew the edge, which is
      // exact — keeping the flag there would report a precision problem that no longer exists.
      if (hi - lo > EPS) {
        out.push({
          startSeconds: lo, endSeconds: hi, label: c.label,
          ...(c.startApprox && lo <= c.startSeconds + EPS ? { startApprox: true } : {}),
        });
      }
    }
  }
  out.sort((a, b) => a.startSeconds - b.startSeconds);
  return out.length >= 2 ? out : undefined;
}
