// All canvas drawing for the timeline. No Angular, no DOM refs beyond the canvas it is handed,
// no component state — everything it draws comes from the TimelineScene it is given, and the
// only outside call it makes is the peaks lookup it was constructed with.

import { EditorSegment } from '../../../models/editor-manifest';
import { MoveDrag, Peaks, TrackRow } from '../model/editor-types';
import { EPS } from '../model/editor-math';
import { chooseTickStep, formatRulerLabel } from '../model/editor-format';
import { storyColor } from '../model/story-utils';
import { TimelineScene } from './timeline-scene';
import {
  RULER_H, RIBBON_H, CLIP_INSET_Y, CLIP_RADIUS, MIN_WAVEFORM_PX
} from './timeline-metrics';

export class TimelineRenderer {
  constructor(
    /** Cached peaks for a clip, or null while an extraction is queued (=== WaveformCache.getOrRequest). */
    private peaks: (seg: EditorSegment, onScreenW: number) => Peaks | null,
  ) {}

  private timeToX(scene: TimelineScene, t: number): number {
    return (t - scene.scrollOffset) * scene.pxPerSec;
  }
  private xToTime(scene: TimelineScene, x: number): number {
    return scene.scrollOffset + x / scene.pxPerSec;
  }

  draw(canvas: HTMLCanvasElement, scene: TimelineScene): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Match backing store to CSS size (devicePixelRatio-aware), then work in CSS px.
    const cssW = canvas.clientWidth || 1000;
    const cssH = canvas.clientHeight || 400;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const W = cssW, H = cssH;
    // App/timeline background.
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#1b1b1e';
    ctx.fillRect(0, 0, W, H);

    const rows = scene.rows;

    // Empty lane backgrounds (gaps read as dark track), with faint separators.
    for (const row of rows) {
      ctx.fillStyle = (row.track.kind === 'video') ? '#202024' : '#1d1d20';
      ctx.fillRect(0, row.top, W, row.height);
      ctx.strokeStyle = '#000';
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(0, row.top + 0.5);
      ctx.lineTo(W, row.top + 0.5);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Blade boundaries, in EDITED seconds, so clips can be split at them. A boundary that a
    // cut swallowed collapses onto a seam via originalToEdited and simply won't fall strictly
    // inside any clip. Computed once per frame.
    const bladeEdited = scene.bladeEdited;

    // Clips. Each clip is split into sub-pieces at any blade boundary that falls strictly
    // inside it, so a cut reads as a real clip division (in EVERY lane) rather than an overlay
    // line. With no interior boundary a clip renders as a single piece (identity behavior).
    for (const row of rows) {
      const segs = scene.segsByTrack.get(row.track.id) || [];
      for (const seg of segs) {
        const x0 = this.timeToX(scene, seg.timelineStart);
        const x1 = this.timeToX(scene, seg.timelineStart + seg.duration);
        if (x1 < 0 || x0 > W) continue; // off-screen
        this.drawClipPieces(ctx, scene, seg, row, W, bladeEdited);
      }
    }

    // Ruler last-but-one so clips never bleed over it.
    this.drawRuler(ctx, scene, W);

    // Stories ribbon in its band directly under the ruler (no-op with zero stories).
    this.drawStoriesRibbon(ctx, scene, W);

    // Selection overlay tints ruler + tracks; playhead draws on top of it.
    this.drawSelection(ctx, scene, W, H);

    // Where an in-flight move would land — above the selection tint, under the playhead.
    this.drawMoveInsertion(ctx, scene, W, H);

    // Playhead over everything (ruler + tracks).
    this.drawPlayhead(ctx, scene, W, H);
  }

  /**
   * FCP-style range selection: a translucent yellow fill across ruler + tracks with 1px edges
   * and small ruler handles. A one-sided pending mark ('i' or 'o' alone) shows a yellow flag.
   */
  private drawSelection(ctx: CanvasRenderingContext2D, scene: TimelineScene, W: number, H: number): void {
    // Every selected range (committed marquee ranges ∪ the in-progress single range) as a
    // translucent yellow band with 1px edges + ruler handles.
    const ranges = scene.selectionRanges;
    for (const range of ranges) {
      const x0 = this.timeToX(scene, range.lo);
      const x1 = this.timeToX(scene, range.hi);
      if (x1 < 0 || x0 > W) continue;
      ctx.save();
      ctx.fillStyle = 'rgba(245,197,24,0.12)';
      ctx.fillRect(x0, 0, x1 - x0, H);
      ctx.strokeStyle = '#f5c518';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x0 + 0.5, 0); ctx.lineTo(x0 + 0.5, H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x1 + 0.5, 0); ctx.lineTo(x1 + 0.5, H); ctx.stroke();
      // 6px handles in the ruler band.
      ctx.fillStyle = '#f5c518';
      ctx.fillRect(x0 - 3, 0, 6, RULER_H);
      ctx.fillRect(x1 - 3, 0, 6, RULER_H);
      ctx.restore();
    }

    // In-progress marquee rectangle (translucent), spanning the track area under the ruler.
    if (scene.marquee.active && scene.marquee.moved) {
      const mx0 = this.timeToX(scene, Math.min(scene.marquee.start, scene.marquee.end));
      const mx1 = this.timeToX(scene, Math.max(scene.marquee.start, scene.marquee.end));
      const top = RULER_H + scene.ribbonHeight;
      ctx.save();
      ctx.fillStyle = 'rgba(150,180,255,0.14)';
      ctx.fillRect(mx0, top, mx1 - mx0, H - top);
      ctx.strokeStyle = 'rgba(150,180,255,0.85)';
      ctx.lineWidth = 1;
      ctx.strokeRect(mx0 + 0.5, top + 0.5, Math.max(0, mx1 - mx0 - 1), H - top - 1);
      ctx.restore();
    }

    // One-sided pending mark ('i' or 'o' alone, no committed ranges) → a small ruler flag.
    if (ranges.length === 0) {
      const one = scene.pendingMark;
      if (one == null) return;
      const x = this.timeToX(scene, one);
      if (x < -1 || x > W + 1) return;
      ctx.save();
      ctx.fillStyle = '#f5c518';
      ctx.fillRect(x - 0.5, 0, 1, RULER_H);
      ctx.beginPath();
      ctx.moveTo(x, 2);
      ctx.lineTo(x + 8, 5);
      ctx.lineTo(x, 8);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  /**
   * Where the moved block will END UP, in EDITED seconds: the snapped drop point minus however
   * much of the selection lies BEFORE it. Lifting the block closes its gaps, so everything at the
   * drop point shifts left by exactly that much — a ghost drawn at the raw drop point would
   * promise a landing spot the drop does not deliver whenever the block moves rightwards.
   * (Verified against the reorder algorithm: the block always lands at exactly this time.)
   */
  private moveLandingTime(d: MoveDrag): number {
    let before = 0;
    for (const r of d.ranges) before += Math.max(0, Math.min(r.hi, d.dropAt) - r.lo);
    return d.dropAt - before;
  }

  /**
   * In-flight selection move: a hard insertion seam at the snapped drop point plus a dashed ghost
   * of the block that will land there, sized to the TOTAL length of the moved footage (the pieces
   * consolidate, so the ghost is what the user will actually get). Drawn only once the drag passes
   * the promotion threshold, so a click inside a highlight shows nothing at all.
   */
  private drawMoveInsertion(ctx: CanvasRenderingContext2D, scene: TimelineScene, W: number, H: number): void {
    const d = scene.moveDrag;
    if (!d || !d.moved) return;
    let len = 0;
    for (const r of d.ranges) len += r.hi - r.lo;
    const landing = this.moveLandingTime(d);
    const gx = this.timeToX(scene, landing);
    const gxEnd = this.timeToX(scene, landing + len);
    const x = this.timeToX(scene, d.dropAt);
    if (gxEnd < -1 && x < -1) return;                    // wholly off-screen
    if (gx > W + 1 && x > W + 1) return;
    const top = RULER_H + scene.ribbonHeight;
    const w = Math.max(1, gxEnd - gx);
    ctx.save();
    ctx.fillStyle = 'rgba(74,158,255,0.16)';
    ctx.fillRect(gx, top, w, H - top);
    ctx.strokeStyle = 'rgba(74,158,255,0.6)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(gx + 0.5, top + 0.5, Math.max(1, w - 1), H - top - 1);
    ctx.setLineDash([]);
    // The seam the pointer is snapped to: full height with caps, so it reads as an insertion point
    // rather than a second playhead.
    ctx.strokeStyle = '#4a9eff';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    ctx.fillStyle = '#4a9eff';
    ctx.beginPath(); ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 8); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x - 5, H); ctx.lineTo(x + 5, H); ctx.lineTo(x, H - 8); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  /**
   * Draw one segment as a clip, split into sub-pieces at every blade boundary (already mapped
   * to EDITED seconds) that falls strictly inside its [timelineStart, timelineStart+duration]
   * span. Each piece is its own rounded clip separated by a ~2px gap, so a cut looks like a real
   * edit — the clip is divided — instead of an overlay line, and it divides EVERY lane the same
   * way because every lane's clips are split against the same boundary set. A clip with no
   * interior boundary is a single piece (byte-for-byte the old rendering).
   */
  private drawClipPieces(ctx: CanvasRenderingContext2D, scene: TimelineScene, seg: EditorSegment,
                         row: TrackRow, W: number, bladeEdited: number[]): void {
    const ts = seg.timelineStart;
    const te = seg.timelineStart + seg.duration;
    // Interior split points, ascending. Strictly inside → a touching boundary is a clip edge
    // already and must not spawn a zero-width sliver.
    const interior: number[] = [];
    for (const b of bladeEdited) {
      if (b > ts + EPS && b < te - EPS) interior.push(b);
    }
    interior.sort((a, b) => a - b);
    const edges = [ts, ...interior, te];
    const GAP = 2;             // px of empty space between adjacent pieces
    for (let i = 0; i < edges.length - 1; i++) {
      let px0 = this.timeToX(scene, edges[i]);
      let px1 = this.timeToX(scene, edges[i + 1]);
      if (i > 0) px0 += GAP / 2;                       // inset the shared edge to open the gap
      if (i < edges.length - 2) px1 -= GAP / 2;
      if (px1 - px0 <= 0.5) continue;                  // piece collapsed by the gap at this zoom
      if (px1 < 0 || px0 > W) continue;                // off-screen piece
      if (row.track.kind === 'video') this.drawVideoClip(ctx, seg, px0, px1, row);
      else this.drawAudioClip(ctx, scene, seg, px0, px1, row, W);
    }
  }

  private roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    const rr = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  private drawVideoClip(ctx: CanvasRenderingContext2D, seg: EditorSegment,
                        x0: number, x1: number, row: TrackRow): void {
    const top = row.top + CLIP_INSET_Y;
    const h = row.height - 2 * CLIP_INSET_Y;
    const w = x1 - x0;

    ctx.save();
    this.roundRectPath(ctx, x0, top, w, h, CLIP_RADIUS);
    ctx.fillStyle = '#6257c9';   // bold indigo-violet (was pale slate #5a6b8c)
    ctx.fill();
    // Subtle top highlight.
    ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(x0, top, w, Math.min(10, h / 2));
    ctx.restore();

    // 1px darker border.
    ctx.save();
    this.roundRectPath(ctx, x0 + 0.5, top + 0.5, w - 1, h - 1, CLIP_RADIUS);
    ctx.strokeStyle = '#4237a6';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    this.drawClipLabel(ctx, seg.label, x0, top, w, h, '#e7e3fb');
  }

  private drawAudioClip(ctx: CanvasRenderingContext2D, scene: TimelineScene, seg: EditorSegment,
                        x0: number, x1: number, row: TrackRow, W: number): void {
    const top = row.top + CLIP_INSET_Y;
    const h = row.height - 2 * CLIP_INSET_Y;
    const w = x1 - x0;

    ctx.save();
    this.roundRectPath(ctx, x0, top, w, h, CLIP_RADIUS);
    ctx.fillStyle = '#2f9e56';   // bold green (was muted #3f7a52)
    ctx.fill();
    ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(x0, top, w, Math.min(8, h / 2));

    // Waveform inside the clip, clipped to its rounded rect. Bold FCP green.
    this.drawWaveInside(ctx, scene, seg, x0, x1, top, h, W);
    ctx.restore();

    ctx.save();
    this.roundRectPath(ctx, x0 + 0.5, top + 0.5, w - 1, h - 1, CLIP_RADIUS);
    ctx.strokeStyle = '#1f7a40';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    this.drawClipLabel(ctx, seg.label, x0, top, w, h, '#dcf7e6');
  }

  private drawClipLabel(ctx: CanvasRenderingContext2D, label: string,
                        x0: number, top: number, w: number, h: number, color: string): void {
    if (w < 22 || !label) return;
    ctx.save();
    this.roundRectPath(ctx, x0, top, w, h, CLIP_RADIUS);
    ctx.clip();
    ctx.fillStyle = color;
    ctx.font = '11px -apple-system, "Segoe UI", sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.globalAlpha = 0.95;
    ctx.fillText(label, Math.max(x0, 0) + 6, top + 13);
    ctx.restore();
  }

  /**
   * Draw a segment's waveform inside its clip as a min/max envelope band. Peaks are
   * lazily extracted per segment (cached); until they arrive a flat placeholder line is
   * drawn and a redraw is scheduled once the fetch resolves.
   */
  private drawWaveInside(ctx: CanvasRenderingContext2D, scene: TimelineScene, seg: EditorSegment,
                         x0: number, x1: number, top: number, h: number, W: number): void {
    const mid = top + h / 2;
    const amp = (h / 2) * 0.82;
    const drawX0 = Math.max(0, Math.floor(x0));
    const drawX1 = Math.min(W, Math.ceil(x1));
    const onScreenW = x1 - x0;

    // Too narrow for a visible waveform: plain fill only, and no extraction request.
    if (onScreenW < MIN_WAVEFORM_PX) return;

    const peaks = this.peaks(seg, onScreenW);
    if (!peaks) {
      // Placeholder: a thin center line so the clip doesn't look empty.
      ctx.strokeStyle = '#6fe895';
      ctx.globalAlpha = 0.4;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(drawX0, mid + 0.5);
      ctx.lineTo(drawX1, mid + 0.5);
      ctx.stroke();
      ctx.globalAlpha = 1;
      return;
    }

    const n = peaks.min.length;
    if (n === 0) return;
    ctx.fillStyle = '#6fe895';
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    let started = false;
    for (let x = drawX0; x <= drawX1; x++) {
      const segTime = this.xToTime(scene, x) - seg.timelineStart;
      const frac = segTime / seg.duration;
      if (frac < 0 || frac >= 1) continue;
      const bi = Math.min(n - 1, Math.max(0, Math.floor(frac * n)));
      const yTop = mid - peaks.max[bi] * amp;
      if (!started) { ctx.moveTo(x + 0.5, yTop); started = true; }
      else ctx.lineTo(x + 0.5, yTop);
    }
    for (let x = drawX1; x >= drawX0; x--) {
      const segTime = this.xToTime(scene, x) - seg.timelineStart;
      const frac = segTime / seg.duration;
      if (frac < 0 || frac >= 1) continue;
      const bi = Math.min(n - 1, Math.max(0, Math.floor(frac * n)));
      const yBot = mid - peaks.min[bi] * amp;
      ctx.lineTo(x + 0.5, yBot);
    }
    if (started) { ctx.closePath(); ctx.fill(); }
    ctx.globalAlpha = 1;
  }

  private drawRuler(ctx: CanvasRenderingContext2D, scene: TimelineScene, W: number): void {
    ctx.fillStyle = '#2a2a2d';
    ctx.fillRect(0, 0, W, RULER_H);
    ctx.strokeStyle = '#000';
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, RULER_H + 0.5);
    ctx.lineTo(W, RULER_H + 0.5);
    ctx.stroke();
    ctx.globalAlpha = 1;

    const step = chooseTickStep(scene.pxPerSec);
    const first = Math.ceil(scene.scrollOffset / step) * step;
    ctx.strokeStyle = '#4a4a50';
    ctx.fillStyle = '#8a8a90';
    ctx.font = '10px -apple-system, "Segoe UI", sans-serif';
    ctx.textBaseline = 'alphabetic';
    for (let t = first; ; t += step) {
      const x = this.timeToX(scene, t);
      if (x > W) break;
      if (x < 0) continue;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, RULER_H - 8);
      ctx.lineTo(x + 0.5, RULER_H);
      ctx.stroke();
      ctx.fillText(formatRulerLabel(t), x + 4, RULER_H - 10);
    }
  }

  /**
   * Draw the stories ribbon in its band directly under the ruler. Each story's RESOLVED
   * regions (from resolveStoryRegions — the same last-writer-wins paint the export will use)
   * render as colored blocks, so nesting reads visually: the leftover pieces of an
   * overpainted story and the block that covered it show the painted result, never the raw
   * overlapping ranges. Region bounds are ORIGINAL seconds mapped through originalToEdited →
   * timeToX, exactly like clips, so the ribbon tracks cuts/scroll/zoom. No-op with zero
   * stories (the band collapses to nothing via ribbonHeight).
   */
  private drawStoriesRibbon(ctx: CanvasRenderingContext2D, scene: TimelineScene, W: number): void {
    if (!scene.hasStories) return;
    const top = RULER_H;
    const h = RIBBON_H;
    // Band background + bottom hairline separating it from the tracks.
    ctx.fillStyle = '#161618';
    ctx.fillRect(0, top, W, h);
    ctx.strokeStyle = '#000';
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, top + h + 0.5);
    ctx.lineTo(W, top + h + 0.5);
    ctx.stroke();
    ctx.globalAlpha = 1;

    const by = top + 1;
    const bh = h - 2;
    for (const s of scene.stories) {
      const color = storyColor(s.number);
      const isActive = s.id === scene.activeStoryId;
      const isPicked = scene.mergePicked.has(s.id);
      // A region draws as one block PER edited piece: reordering can scatter a single original
      // region across the edited timeline, and mapping only its two ends would give a
      // negative-width block that silently vanishes from the ribbon. One piece in source order.
      for (const piece of s.regions.flatMap(r => scene.storyRibbonPieces(r))) {
        const x0 = this.timeToX(scene, piece.lo);
        const x1 = this.timeToX(scene, piece.hi);
        if (x1 <= x0) continue;
        if (x1 < 0 || x0 > W) continue;              // off-screen
        const bx0 = Math.max(0, x0);
        const bx1 = Math.min(W, x1);
        const bw = bx1 - bx0;
        if (bw <= 0.5) continue;                     // collapsed at this zoom
        ctx.save();
        this.roundRectPath(ctx, bx0, by, bw, bh, 2);
        ctx.fillStyle = color;
        // Picked-for-merge reads as bright as active: the user is about to act on it.
        ctx.globalAlpha = (isActive || isPicked) ? 1 : 0.7;
        ctx.fill();
        ctx.globalAlpha = 1;
        // Picked wins the outline over active — the pick is the pending action, and a story can
        // be both. Blue matches the Merge button; white stays the "this is the paint target" cue.
        if (isPicked) {
          ctx.strokeStyle = '#4a9eff';
          ctx.lineWidth = 2.5;
          ctx.stroke();
        } else if (isActive) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        if (bw > 22 && s.title) {
          ctx.clip();
          ctx.fillStyle = '#141208';
          ctx.font = '10px -apple-system, "Segoe UI", sans-serif';
          ctx.textBaseline = 'middle';
          ctx.fillText(s.title, bx0 + 5, by + bh / 2 + 0.5);
        }
        ctx.restore();
      }
    }
  }

  private drawPlayhead(ctx: CanvasRenderingContext2D, scene: TimelineScene, W: number, H: number): void {
    const x = this.timeToX(scene, scene.playheadTime);
    if (x < -1 || x > W + 1) return;
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, H);
    ctx.stroke();
    // Downward triangle head in the ruler.
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(x - 5, 0);
    ctx.lineTo(x + 6, 0);
    ctx.lineTo(x + 0.5, 9);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}
