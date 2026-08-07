// Per-editor waveform peaks cache + the bounded ffmpeg extraction queue behind it.
// A plain class, not @Injectable: one instance per editor, wired with callbacks so it has no
// dependency on ElectronService or on the component's render loop.

import { EditorSegment } from '../../../models/editor-manifest';
import { Peaks } from '../model/editor-types';

export class WaveformCache {
  constructor(
    private extract: (o: { filePath: string; startSec: number; durationSec: number; buckets: number })
      => Promise<{ success?: boolean; min?: number[]; max?: number[]; error?: any }>,
    /** Called when a landed extraction has something new to draw (=== requestRender). */
    private onPeaksReady: () => void,
  ) {}

  // Waveform bucketing: ~2 buckets per CSS px of the clip's on-screen width, capped.
  private readonly BUCKETS_PER_PX = 2;
  private readonly MAX_BUCKETS = 4000;
  private readonly MIN_BUCKETS = 8;
  // Peak extractions each spawn an ffmpeg process in the main process — cap how many
  // run at once; the rest queue.
  private readonly MAX_CONCURRENT_PEAKS = 4;

  private peaksCache = new Map<string, Peaks>();
  private peaksInFlight = new Set<string>();
  private peaksActive = 0;
  private peaksQueue: Array<() => Promise<void>> = [];
  // Determinate progress for the current extraction burst (surfaced in the Activity window).
  // A burst starts when work is requested with nothing outstanding; done/total climb as
  // ffmpeg extractions land. New clips scrolling into a live burst extend `total`.
  burstTotal = 0;
  burstDone = 0;

  /** Waveform peaks are still being extracted (queued or running ffmpeg). */
  get active(): boolean {
    return this.peaksActive > 0 || this.peaksQueue.length > 0;
  }

  /** Determinate % for the current waveform-extraction burst (0 when idle). */
  get pct(): number {
    if (this.burstTotal <= 0) return 0;
    return Math.min(100, Math.round((this.burstDone / this.burstTotal) * 100));
  }

  /**
   * Drop everything belonging to the old session. In-flight extractions are deliberately NOT
   * cancelled: a landed extraction for the old session writes into the cleared map (a harmless
   * orphan entry keyed by a file the new session does not draw) and its `finally` still runs, so
   * the concurrency count stays honest. Cancelling would need a generation token on every job.
   */
  clear(): void {
    this.peaksCache.clear();
    this.peaksInFlight.clear();
    this.peaksQueue = [];   // queued (not yet started) extractions for the old session
    this.burstTotal = 0;
    this.burstDone = 0;
  }

  private peaksKey(seg: EditorSegment, buckets: number): string {
    return `${seg.file}|${seg.sourceStart}|${seg.duration}|${buckets}`;
  }

  getOrRequest(seg: EditorSegment, onScreenW: number): Peaks | null {
    // Quantize the bucket count to a power of two: continuous zooming then produces a
    // small bounded set of cache keys (~10 per segment) instead of minting a fresh
    // ffmpeg extraction for every intermediate zoom level.
    const desired = Math.min(this.MAX_BUCKETS,
      Math.max(this.MIN_BUCKETS, Math.round(onScreenW * this.BUCKETS_PER_PX)));
    const buckets = Math.min(this.MAX_BUCKETS, Math.pow(2, Math.ceil(Math.log2(desired))));
    const key = this.peaksKey(seg, buckets);
    const cached = this.peaksCache.get(key);
    if (cached) return cached;
    if (!this.peaksInFlight.has(key)) {
      // Fresh burst? (nothing running or queued) — restart the progress counters so the
      // Activity window shows this batch from 0, not a stale carry-over.
      if (this.peaksActive === 0 && this.peaksQueue.length === 0) {
        this.burstTotal = 0;
        this.burstDone = 0;
      }
      this.burstTotal++;
      this.peaksInFlight.add(key);
      this.peaksQueue.push(async () => {
        try {
          const res = await this.extract({
            filePath: seg.file, startSec: seg.sourceStart, durationSec: seg.duration, buckets
          });
          if (res?.success && res.min && res.max) {
            this.peaksCache.set(key, { min: res.min, max: res.max });
            this.onPeaksReady();
          } else {
            // Non-fatal (the clip keeps its placeholder line; playback still uses the
            // real file) but never silent — a flat line must not masquerade as silence.
            console.error(`Peak extraction failed for ${seg.file} [${seg.sourceStart}s +${seg.duration}s]:`, res?.error || res);
          }
        } catch (err: any) {
          console.error(`Peak extraction failed for ${seg.file} [${seg.sourceStart}s +${seg.duration}s]:`, err?.message || err);
        } finally {
          this.peaksInFlight.delete(key);
          this.burstDone++;
        }
      });
      this.pumpPeaksQueue();
    }
    return null;
  }

  /** Run queued peak extractions, at most MAX_CONCURRENT_PEAKS ffmpeg spawns at once. */
  private pumpPeaksQueue(): void {
    while (this.peaksActive < this.MAX_CONCURRENT_PEAKS && this.peaksQueue.length > 0) {
      const job = this.peaksQueue.shift()!;
      this.peaksActive++;
      void job().finally(() => {
        this.peaksActive--;
        this.pumpPeaksQueue();
      });
    }
  }
}
