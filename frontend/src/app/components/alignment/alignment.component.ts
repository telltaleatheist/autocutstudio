import { Component, OnInit, OnDestroy, AfterViewInit, ViewChild, ElementRef, HostListener, ChangeDetectorRef } from '@angular/core';
import { ElectronService } from '../../services/electron.service';

/**
 * Manual-alignment wizard (its own Electron window).
 *
 * Sources: AUDIO (mic1 / mic2 / screen) then VIDEO (cam1 / cam2 / screen). Video sources
 * carry embedded scratch audio, so the SAME waveform mechanics align them; a video step
 * additionally shows a muted <video> preview for a lip-check. The step list is built from
 * a generic { kind, type, phase } model. Drift (a nonzero END nudge) is gated: allowed for
 * audio (clock-drift resample in the pipeline) and for the screen/cam2 video sources
 * (manual retime); refused only for cam1 (records with the master, never retimed). The
 * game video gets NO step — it follows wherever the screen video lands (GAME RULE).
 *
 * Each source is aligned against the MASTER waveform in two steps:
 *   - START: ~10 s window at the source's first sustained audio, source pre-shifted by
 *            the measured offset; user nudges (integer frames) until start lines up.
 *   - END:   ~10 s window at the source's last sustained audio, START offset carried
 *            over; if the end needs a different offset that implies clock drift.
 *
 * NUMBERS ARE SACRED: the stored offset is measuredSeed + frames*FRAME_SECONDS with no
 * extra rounding. NO SILENT FALLBACKS: any ffmpeg/IPC failure surfaces and blocks.
 */

interface WizardSource {
  kind: 'audio' | 'video';
  type: string;            // normalized: mic1, mic2, screen (video later: screen, game, cam1...)
  label: string;
  path: string;
  measuredOffset: number;  // seconds; positive = source delayed rightward
  confidence: number;
  trusted: boolean;
  // Coarse-scan results (source-local seconds).
  firstSustainedSec: number;
  lastSustainedSec: number;
  durationSec: number;
  // Nudge state — integer frames only.
  startFrames: number;     // START-step nudge on top of the measured seed
  endFrames: number;       // END-step EXTRA nudge on top of the carried START offset
  startVisited: boolean;
  endVisited: boolean;
}

interface WizardStep {
  sourceIndex: number;
  phase: 'start' | 'end';
}

interface Peaks { min: number[]; max: number[]; }

@Component({
  selector: 'app-alignment',
  standalone: false,
  templateUrl: './alignment.component.html',
  styleUrl: './alignment.component.scss'
})
export class AlignmentComponent implements OnInit, AfterViewInit, OnDestroy {
  // ── Constants (documented; no magic numbers) ──────────────────────────────
  /** One frame at 29.97 fps timeline = 1001/30000 s. Arrow-key nudge granularity. */
  readonly FRAME_SECONDS = 1001 / 30000;
  /** Visible zoom span. */
  private readonly WINDOW_SEC = 10;
  /** Extra source footage decoded either side of the window so nudging can slide it. */
  private readonly PAD_SEC = 3;
  /** Fine peak resolution (buckets across the padded extraction window). */
  private readonly PEAK_BUCKETS = 2000;
  /** Playback decode rate. */
  private readonly PLAYBACK_SR = 48000;
  /** Shift+Arrow multiplier. */
  private readonly COARSE_FRAMES = 10;

  @ViewChild('waveCanvas') canvasRef!: ElementRef<HTMLCanvasElement>;
  // Lives inside an *ngIf (video steps only), so it is optional and re-queried per step.
  @ViewChild('previewVideo') previewVideoRef?: ElementRef<HTMLVideoElement>;

  masterVideo = '';
  sources: WizardSource[] = [];
  steps: WizardStep[] = [];
  stepIndex = 0;

  // GAME RULE plumbing: whether a game video exists at all (passed through the payload).
  // Game gets no wizard step; at finish it inherits the screen video's override.
  private gamePresent = false;

  loading = true;
  loadingMessage = 'Preparing…';
  errorMessage = '';
  finished = false;

  // Per-step render cache (recomputed on entering a step; nudges only re-render).
  private masterPeaks: Peaks | null = null;
  private sourcePeaks: Peaks | null = null;
  private mStart = 0;            // master window start (timeline seconds)
  private srcExtractStart = 0;   // source extraction window start (source seconds)
  private srcExtractDur = 0;     // source extraction window duration (seconds)

  // Playback state.
  private audioCtx: AudioContext | null = null;
  private activeNodes: AudioBufferSourceNode[] = [];
  private videoPlayTimer: number | null = null;
  isPlaying = false;

  // Playhead: absolute master-time seconds, clamped to the visible window [mStart, mStart+WINDOW].
  // It drives PLAYBACK START and the VIDEO PREVIEW scrub only — never the stored offsets.
  private playheadTime = 0;
  // Playhead animation (requestAnimationFrame against audioCtx.currentTime during playback).
  private rafId: number | null = null;
  private playbackAnchorCtxTime = 0;  // audioCtx.currentTime at which the playhead == playbackAnchorTime
  private playbackAnchorTime = 0;     // master-time seconds the playhead started from (pStart)
  // Playhead drag state.
  private dragging = false;
  private wasPlayingBeforeDrag = false;

  constructor(private electron: ElectronService, private cdr: ChangeDetectorRef) {}

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  async ngOnInit(): Promise<void> {
    // Pull the seed payload (race-free); also accept the pushed copy if it lands first.
    let payload: any = null;
    this.electron.onAlignmentPayload((p) => {
      if (!payload && p) { payload = p; void this.bootstrap(payload); }
    });
    try {
      const res = await this.electron.getAlignmentPayload();
      if (res?.success && res.payload && !payload) {
        payload = res.payload;
        await this.bootstrap(payload);
      } else if (!res?.payload && !payload) {
        // Payload may still arrive via the push listener; keep the busy state.
        this.loadingMessage = 'Waiting for alignment data…';
      }
    } catch (err: any) {
      this.fail(`Could not load alignment data: ${err?.message || err}`);
    }
  }

  ngAfterViewInit(): void {
    this.render();
  }

  ngOnDestroy(): void {
    this.stopPlayback();
    window.removeEventListener('mousemove', this.onWindowMouseMove);
    window.removeEventListener('mouseup', this.onWindowMouseUp);
    if (this.audioCtx) { void this.audioCtx.close(); this.audioCtx = null; }
    this.electron.removeAlignmentListeners?.();
  }

  // ── Bootstrap: build sources + steps from the payload, coarse-scan each source ─
  private async bootstrap(payload: any): Promise<void> {
    try {
      this.masterVideo = payload.masterVideo;
      const audio = payload.audio || {};
      const video = payload.video || {};
      this.gamePresent = !!payload.gamePresent;

      // Deterministic, per-source (start,end) ordering. Video kinds append later.
      const AUDIO_ORDER = ['mic1', 'mic2', 'mic3', 'mic4', 'screen', 'game', 'bluetooth', 'soundEffects'];
      const types = Object.keys(audio).sort((a, b) => {
        const ia = AUDIO_ORDER.indexOf(a); const ib = AUDIO_ORDER.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });

      if (types.length === 0) {
        this.fail('No audio sources to align.');
        return;
      }

      const built: WizardSource[] = [];
      for (const type of types) {
        const info = audio[type];
        this.loadingMessage = `Scanning ${this.labelFor('audio', type)}…`;
        this.cdr.detectChanges();
        const scan = await this.electron.alignmentScanActivity(info.path);
        if (!scan?.success) {
          this.fail(`Could not analyse ${this.labelFor('audio', type)}: ${scan?.error || 'unknown error'}`);
          return;
        }
        built.push({
          kind: 'audio',
          type,
          label: this.labelFor('audio', type),
          path: info.path,
          measuredOffset: Number(info.offsetSeconds) || 0,
          confidence: Number(info.confidence) || 0,
          trusted: !!info.trusted,
          firstSustainedSec: scan.firstSustainedSec!,
          lastSustainedSec: scan.lastSustainedSec!,
          durationSec: scan.durationSec!,
          startFrames: 0,
          endFrames: 0,
          startVisited: false,
          endVisited: false,
        });
      }

      // VIDEO sources (appended AFTER all audio, in cam1 → cam2 → screen order). Each
      // video has embedded scratch audio, so the same coarse-scan + waveform mechanics
      // apply — scanActivity/extractPeaks/extractSamples decode the file's audio track.
      // 'game' is never in this map (GAME RULE): it follows screen at finish.
      const VIDEO_ORDER = ['cam1', 'cam2', 'screen'];
      const videoTypes = Object.keys(video).sort((a, b) => {
        const ia = VIDEO_ORDER.indexOf(a); const ib = VIDEO_ORDER.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
      for (const type of videoTypes) {
        const info = video[type];
        this.loadingMessage = `Scanning ${this.labelFor('video', type)}…`;
        this.cdr.detectChanges();
        const scan = await this.electron.alignmentScanActivity(info.path);
        if (!scan?.success) {
          this.fail(`Could not analyse ${this.labelFor('video', type)}: ${scan?.error || 'unknown error'}`);
          return;
        }
        built.push({
          kind: 'video',
          type,
          label: this.labelFor('video', type),
          path: info.path,
          measuredOffset: Number(info.offsetSeconds) || 0,
          confidence: Number(info.confidence) || 0,
          trusted: !!info.trusted,
          firstSustainedSec: scan.firstSustainedSec!,
          lastSustainedSec: scan.lastSustainedSec!,
          durationSec: scan.durationSec!,
          startFrames: 0,
          endFrames: 0,
          startVisited: false,
          endVisited: false,
        });
      }

      this.sources = built;
      this.steps = [];
      built.forEach((_s, i) => {
        this.steps.push({ sourceIndex: i, phase: 'start' });
        this.steps.push({ sourceIndex: i, phase: 'end' });
      });

      this.loading = false;
      this.cdr.detectChanges();
      await this.enterStep(0);
    } catch (err: any) {
      this.fail(`Failed to prepare alignment: ${err?.message || err}`);
    }
  }

  private labelFor(kind: string, type: string): string {
    if (kind === 'video') {
      const VIDEO_LABELS: { [k: string]: string } = {
        cam1: 'Camera 1', cam2: 'Camera 2', screen: 'Screen Video', game: 'Game Video'
      };
      return VIDEO_LABELS[type] || type;
    }
    const LABELS: { [k: string]: string } = {
      mic1: 'Mic 1', mic2: 'Mic 2', mic3: 'Mic 3', mic4: 'Mic 4',
      screen: 'Screen Audio', game: 'Game Audio', bluetooth: 'Bluetooth', soundEffects: 'Sound Effects'
    };
    return LABELS[type] || type;
  }

  // ── Step navigation ────────────────────────────────────────────────────────
  get currentStep(): WizardStep | null {
    return this.steps[this.stepIndex] || null;
  }
  get currentSource(): WizardSource | null {
    const s = this.currentStep;
    return s ? this.sources[s.sourceIndex] : null;
  }
  get isStartPhase(): boolean { return this.currentStep?.phase === 'start'; }
  get isEndPhase(): boolean { return this.currentStep?.phase === 'end'; }
  get isVideoStep(): boolean { return this.currentSource?.kind === 'video'; }
  /**
   * Whether a nonzero END nudge (clock drift) is allowed for a source. The pipeline
   * SUPPORTS drift for AUDIO sources (clock-drift resample in apply_sync_to_audio)
   * and for the screen/cam2 VIDEO sources (manual retime via calculate_retime_map).
   * It REFUSES cam1 drift — cam1 records with the master and is never retimed.
   */
  private driftAllowedFor(src: WizardSource): boolean {
    if (src.kind === 'audio') return true;
    return src.type === 'screen' || src.type === 'cam2';
  }
  get isFirstStep(): boolean { return this.stepIndex === 0; }
  get isLastStep(): boolean { return this.stepIndex === this.steps.length - 1; }
  get stepLabel(): string {
    const src = this.currentSource;
    if (!src) return '';
    return `${src.label} — ${this.isStartPhase ? 'Start' : 'End'}`;
  }

  /** Load master + source peaks for the step and render. Fails loud on IPC error. */
  private async enterStep(index: number): Promise<void> {
    this.stopPlayback();
    this.stepIndex = index;
    const step = this.currentStep!;
    const src = this.sources[step.sourceIndex];
    this.loading = true;
    this.loadingMessage = 'Loading waveforms…';
    this.errorMessage = '';
    this.cdr.detectChanges();

    // Source window (source-local seconds).
    const maxStart = Math.max(0, src.durationSec - this.WINDOW_SEC);
    const srcWinStart = step.phase === 'start'
      ? Math.min(src.firstSustainedSec, maxStart)
      : Math.max(0, Math.min(src.lastSustainedSec - this.WINDOW_SEC, maxStart));

    // The offset in force when the step opens anchors the fixed master window.
    const offsetAtEntry = step.phase === 'start'
      ? this.offsetStart(src)
      : this.offsetStart(src); // END carries the START offset (endFrames starts at 0)

    this.mStart = Math.max(0, srcWinStart + offsetAtEntry);
    this.srcExtractStart = Math.max(0, srcWinStart - this.PAD_SEC);
    this.srcExtractDur = this.WINDOW_SEC + 2 * this.PAD_SEC;
    // A new step resets the playhead to the window start.
    this.playheadTime = this.mStart;

    try {
      const [mp, sp] = await Promise.all([
        this.electron.alignmentExtractPeaks({
          filePath: this.masterVideo, startSec: this.mStart, durationSec: this.WINDOW_SEC, buckets: this.PEAK_BUCKETS
        }),
        this.electron.alignmentExtractPeaks({
          filePath: src.path, startSec: this.srcExtractStart, durationSec: this.srcExtractDur, buckets: this.PEAK_BUCKETS
        }),
      ]);
      if (!mp?.success) throw new Error(`master waveform: ${mp?.error || 'failed'}`);
      if (!sp?.success) throw new Error(`source waveform: ${sp?.error || 'failed'}`);
      this.masterPeaks = { min: mp.min!, max: mp.max! };
      this.sourcePeaks = { min: sp.min!, max: sp.max! };
      if (step.phase === 'start') src.startVisited = true; else src.endVisited = true;
      this.loading = false;
      this.cdr.detectChanges();
      this.render();
      // On video steps, (re)point the <video> at this source and park it at the center.
      // The element only exists once change detection has run the video-step *ngIf.
      this.updatePreviewVideo();
    } catch (err: any) {
      this.fail(`Could not load waveforms: ${err?.message || err}`);
    }
  }

  async onBack(): Promise<void> {
    if (this.isFirstStep || this.loading) return;
    await this.enterStep(this.stepIndex - 1);
  }

  async onNext(): Promise<void> {
    if (this.loading) return;
    const src = this.currentSource!;
    // END step gates on drift. A nonzero end nudge is ALLOWED for audio (clock-drift
    // resample) and the screen/cam2 video sources (manual retime). It is blocked only
    // for cam1 (records with the master, never retimed).
    if (this.isEndPhase && src.endFrames !== 0 && !this.driftAllowedFor(src)) {
      // Blocked — do not advance, do not drop the nudge. Message shown in template.
      return;
    }
    if (this.isLastStep) {
      await this.finish();
      return;
    }
    await this.enterStep(this.stepIndex + 1);
  }

  async onCancel(): Promise<void> {
    this.stopPlayback();
    await this.electron.cancelAlignment();
  }

  /** Reset the END nudge back to the START offset (offset-only, no drift). */
  resetEndNudge(): void {
    const src = this.currentSource;
    if (!src) return;
    src.endFrames = 0;
    if (this.isPlaying) this.restartPlayback();
    else this.seekPreviewToPlayhead();
    this.render();
  }

  // ── Offsets & drift (numbers sacred) ───────────────────────────────────────
  private offsetStart(src: WizardSource): number {
    return src.measuredOffset + src.startFrames * this.FRAME_SECONDS;
  }
  private offsetEnd(src: WizardSource): number {
    return this.offsetStart(src) + src.endFrames * this.FRAME_SECONDS;
  }
  /** Offset applied to the source in the CURRENT step. */
  private currentOffset(): number {
    const src = this.currentSource!;
    return this.isStartPhase ? this.offsetStart(src) : this.offsetEnd(src);
  }

  /**
   * Drift derivation (consistent with core/xml_utils.py calculate_retime_map, Method A).
   *
   * Convention: positive offset = source delayed rightward; a source event at source-local
   * time s lands on the timeline at (offset + s), so aligning event k gives offset_k = m_k - s_k
   * (m = master time, s = source time). With T = master span between the two anchors and
   * S = the source span between the same two events:
   *
   *     endNudge = offset_end - offset_start = (m_end-m_start) - (s_end-s_start) = M - S = T - S
   *
   * calculate_retime_map Method A uses  r = T / (T - Δ),  where Δ = drift_seconds and
   * "positive Δ = source too long" (S > M). Hence Δ = S - M = -endNudge, giving
   *
   *     r = T / (T - Δ) = T / (T + endNudge)
   *
   * Sign check: endNudge > 0 (source needed MORE rightward shift at the end) ⇒ S < T ⇒ the
   * source ran SLOW (too short) ⇒ Δ < 0 ⇒ r < 1 (source_duration = T*r < T, played slower).
   * endNudge == 0 ⇒ Δ = 0 ⇒ r = 1.0 exactly (verified no drift).
   *
   * T is the anchor span, approximated by the source-time distance between first/last
   * sustained audio (differs from the master-time span only by the offset delta — sub-frame
   * over a multi-minute span — negligible, and the block decision below is exact anyway
   * because nudges are integer frames).
   */
  get anchorSpanSec(): number {
    const src = this.currentSource;
    if (!src) return 0;
    return Math.max(1e-6, src.lastSustainedSec - src.firstSustainedSec);
  }
  get endNudgeSeconds(): number {
    const src = this.currentSource;
    if (!src) return 0;
    return src.endFrames * this.FRAME_SECONDS;
  }
  get driftFactor(): number {
    const src = this.currentSource;
    return src ? this.driftFactorFor(src) : 1;
  }
  /** r = T / (T + endNudge) for a given source (numbers sacred; see block comment above). */
  private driftFactorFor(src: WizardSource): number {
    const T = Math.max(1e-6, src.lastSustainedSec - src.firstSustainedSec);
    const endNudge = src.endFrames * this.FRAME_SECONDS;
    return T / (T + endNudge);
  }
  /** True when the END nudge implies clock drift (any nonzero integer-frame nudge). */
  get hasDrift(): boolean {
    return this.isEndPhase && (this.currentSource?.endFrames ?? 0) !== 0;
  }
  /** Drift the pipeline would refuse — blocks Next and shows an explanatory message. */
  get driftBlocked(): boolean {
    const src = this.currentSource;
    return !!src && this.hasDrift && !this.driftAllowedFor(src);
  }
  /** Drift the pipeline accepts (audio resample, or screen/cam2 video retime) — r shown as a note. */
  get driftAccepted(): boolean {
    const src = this.currentSource;
    return !!src && this.hasDrift && this.driftAllowedFor(src);
  }
  /** cam1-specific block: cam1 records with the master and must not drift. */
  get isCam1Block(): boolean {
    return this.driftBlocked && this.currentSource?.kind === 'video' && this.currentSource?.type === 'cam1';
  }

  // ── Readouts ───────────────────────────────────────────────────────────────
  get currentOffsetSeconds(): number { return this.currentOffset(); }
  get currentOffsetFrames(): number { return this.currentOffsetSeconds / this.FRAME_SECONDS; }
  formatSeconds(s: number): string { return `${s >= 0 ? '+' : ''}${s.toFixed(4)} s`; }
  formatFrames(f: number): string { return `${f >= 0 ? '+' : ''}${f.toFixed(2)} fr`; }

  // ── Keyboard: nudging + playback ────────────────────────────────────────────
  @HostListener('window:keydown', ['$event'])
  onKeyDown(ev: KeyboardEvent): void {
    if (this.loading || this.finished || !this.currentSource) return;
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      ev.preventDefault();
      const dir = ev.key === 'ArrowRight' ? 1 : -1;       // right = delay source (offset increases)
      const step = ev.shiftKey ? this.COARSE_FRAMES : 1;
      this.nudge(dir * step);
    } else if (ev.key === ' ' || ev.code === 'Space') {
      ev.preventDefault();
      this.togglePlayback();
    }
  }

  private nudge(frames: number): void {
    const src = this.currentSource!;
    if (this.isStartPhase) src.startFrames += frames; else src.endFrames += frames;
    this.render();
    // Offset changed, so the source-local time under the (fixed) playhead changed: re-seek the
    // preview so nudging visibly steps the frame. If playing, restartPlayback re-syncs the video.
    if (this.isPlaying) this.restartPlayback();
    else this.seekPreviewToPlayhead();
    this.cdr.detectChanges();
  }

  // ── Canvas rendering ────────────────────────────────────────────────────────
  /** Cool, theme-neutral color for the MASTER waveform (contrasts the orange source). */
  private readonly MASTER_COLOR = '#4a9eff';

  private render(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Match backing store to CSS size for crispness.
    const cssW = canvas.clientWidth || 1000;
    const cssH = canvas.clientHeight || 360;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const W = cssW, H = cssH;
    const css = getComputedStyle(document.body);
    const orange = (css.getPropertyValue('--primary-orange') || '#ff6b35').trim();
    const border = (css.getPropertyValue('--border-color') || '#374151').trim();
    const textMuted = (css.getPropertyValue('--text-muted') || '#9ca3af').trim();
    const textPrimary = (css.getPropertyValue('--text-primary') || '#ffffff').trim();
    const bgCard = (css.getPropertyValue('--bg-card') || '#1e1e1e').trim();

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = bgCard;
    ctx.fillRect(0, 0, W, H);

    if (!this.masterPeaks || !this.sourcePeaks) return;

    // Frame gridlines (full height).
    this.drawGrid(ctx, W, H, border);

    // MASTER — full-height filled band, fixed. masterTime at x = mStart + (x/W)*WINDOW, so the
    // fraction into the master peak array is simply x/W.
    this.drawWaveBand(ctx, this.masterPeaks, W, 0, H, (x) => x / W, this.MASTER_COLOR, 0.85);

    // SOURCE — shifted by the current offset. At master time m (x) the source-local time is
    // m - offset; bucket over the padded extraction window.
    const offset = this.currentOffset();
    const srcFrac = (x: number) => {
      const m = this.mStart + (x / W) * this.WINDOW_SEC;
      const s = m - offset;
      return (s - this.srcExtractStart) / this.srcExtractDur;
    };

    if (this.isVideoStep) {
      // VIDEO: draw the source as an NLE-style clip block that slides with the offset. Its
      // timeline extent is the decoded (padded) source window mapped through the offset.
      const blockX0 = ((this.srcExtractStart + offset) - this.mStart) / this.WINDOW_SEC * W;
      const blockX1 = ((this.srcExtractStart + this.srcExtractDur + offset) - this.mStart) / this.WINDOW_SEC * W;
      this.drawClipBlock(ctx, blockX0, blockX1, W, H, orange, this.sourcePeaks, srcFrac);
    } else {
      // AUDIO: plain translucent overlay over the master.
      this.drawWaveBand(ctx, this.sourcePeaks, W, 0, H, srcFrac, orange, 0.55);
    }

    // Playhead (on top of the waveforms), then the color-keyed legend.
    this.drawPlayhead(ctx, W, H, textPrimary);
    this.drawLegend(ctx, W, this.MASTER_COLOR, orange, textMuted);
  }

  /**
   * Draw a waveform as a FILLED min/max envelope band across the full height. `frac(x)` maps a
   * canvas x to the [0,1] position into the peak array; samples outside [0,1) are skipped. A
   * filled band (vs 1px strokes) keeps two overlaid waveforms legible on both themes.
   */
  private drawWaveBand(ctx: CanvasRenderingContext2D, peaks: Peaks, W: number, top: number, h: number,
                       frac: (x: number) => number, color: string, alpha: number): void {
    const n = peaks.min.length;
    const mid = top + h / 2;
    const amp = (h / 2) * 0.9;
    const xs: number[] = [], his: number[] = [], los: number[] = [];
    for (let x = 0; x < W; x++) {
      const f = frac(x);
      if (f < 0 || f >= 1) continue;
      const bi = Math.min(n - 1, Math.max(0, Math.floor(f * n)));
      xs.push(x); his.push(peaks.max[bi]); los.push(peaks.min[bi]);
    }
    if (xs.length === 0) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(xs[0] + 0.5, mid - his[0] * amp);
    for (let i = 1; i < xs.length; i++) ctx.lineTo(xs[i] + 0.5, mid - his[i] * amp);
    for (let i = xs.length - 1; i >= 0; i--) ctx.lineTo(xs[i] + 0.5, mid - los[i] * amp);
    ctx.closePath();
    ctx.fill();
    // A thin center-of-mass stroke along the max edge sharpens the read at low amplitudes.
    ctx.globalAlpha = Math.min(1, alpha + 0.25);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Draw the sliding VIDEO clip block: a rounded-rect container (translucent orange fill + orange
   * border + label) with the source waveform drawn INSIDE it over the master. The rect uses the
   * true (unclamped) block edges so an edge that is off-canvas simply reads as "continues beyond";
   * nudging slides the whole unit. The fill is translucent enough that the master shows through.
   */
  private drawClipBlock(ctx: CanvasRenderingContext2D, bx0: number, bx1: number, W: number, H: number,
                        orange: string, peaks: Peaks, frac: (x: number) => number): void {
    if (bx1 <= bx0) return;
    const inset = 6;
    const top = inset, height = H - 2 * inset;
    const r = 8;

    // Translucent fill.
    ctx.save();
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = orange;
    this.roundRectPath(ctx, bx0, top, bx1 - bx0, height, r);
    ctx.fill();
    ctx.restore();

    // Source waveform, clipped to the block, over the master underneath.
    ctx.save();
    this.roundRectPath(ctx, bx0, top, bx1 - bx0, height, r);
    ctx.clip();
    this.drawWaveBand(ctx, peaks, W, 0, H, frac, orange, 0.7);
    ctx.restore();

    // Border.
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = orange;
    ctx.lineWidth = 2;
    this.roundRectPath(ctx, bx0, top, bx1 - bx0, height, r);
    ctx.stroke();
    ctx.restore();

    // Label — pinned near the visible left edge of the block, clipped inside it.
    ctx.save();
    this.roundRectPath(ctx, bx0, top, bx1 - bx0, height, r);
    ctx.clip();
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = orange;
    ctx.font = 'bold 11px sans-serif';
    ctx.textBaseline = 'alphabetic';
    const label = `${(this.currentSource?.label || 'SOURCE').toUpperCase()} ▸ CLIP`;
    ctx.fillText(label, Math.max(bx0, 0) + 8, top + 16);
    ctx.restore();
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

  /** The draggable playhead: a full-height line at the playhead time, with a grab handle on top. */
  private drawPlayhead(ctx: CanvasRenderingContext2D, W: number, H: number, color: string): void {
    const x = ((this.playheadTime - this.mStart) / this.WINDOW_SEC) * W;
    if (x < -1 || x > W + 1) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, H);
    ctx.stroke();
    // Grab handle (triangle) at the top.
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x - 5, 0);
    ctx.lineTo(x + 5, 0);
    ctx.lineTo(x + 0.5, 9);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /** Small color-keyed legend (MASTER / SOURCE swatches) in the top-right corner. */
  private drawLegend(ctx: CanvasRenderingContext2D, W: number, masterColor: string, orange: string,
                     textColor: string): void {
    ctx.save();
    ctx.font = '11px sans-serif';
    ctx.textBaseline = 'middle';
    const sw = 11, gap = 5, itemGap = 14, pad = 10, y = 12;
    const entries = [{ c: masterColor, t: 'MASTER' }, { c: orange, t: 'SOURCE' }];
    let total = 0;
    for (const e of entries) total += sw + gap + ctx.measureText(e.t).width + itemGap;
    total -= itemGap;
    let x = W - pad - total;
    for (const e of entries) {
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = e.c;
      ctx.fillRect(x, y - sw / 2, sw, sw);
      x += sw + gap;
      ctx.globalAlpha = 1;
      ctx.fillStyle = textColor;
      ctx.fillText(e.t, x, y);
      x += ctx.measureText(e.t).width + itemGap;
    }
    ctx.restore();
  }

  private drawGrid(ctx: CanvasRenderingContext2D, W: number, H: number, border: string): void {
    // Frame gridlines: vertical lines at each whole-frame boundary across the window.
    const pxPerSec = W / this.WINDOW_SEC;
    ctx.strokeStyle = border;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 1;
    const firstFrame = Math.ceil(this.mStart / this.FRAME_SECONDS);
    for (let fr = firstFrame; ; fr++) {
      const t = fr * this.FRAME_SECONDS;
      const x = (t - this.mStart) * pxPerSec;
      if (x > W) break;
      if (x < 0) continue;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, H);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // ── Playhead interaction (click / drag to position) ──────────────────────────
  onCanvasMouseDown(ev: MouseEvent): void {
    if (this.loading || this.finished || !this.currentSource) return;
    ev.preventDefault();
    this.dragging = true;
    // A click/drag interrupts playback; if we were playing we resume from the new spot on release.
    this.wasPlayingBeforeDrag = this.isPlaying;
    if (this.isPlaying) this.stopPlayback();
    this.setPlayheadFromEvent(ev);
    window.addEventListener('mousemove', this.onWindowMouseMove);
    window.addEventListener('mouseup', this.onWindowMouseUp);
  }

  private onWindowMouseMove = (ev: MouseEvent): void => {
    if (!this.dragging) return;
    this.setPlayheadFromEvent(ev);
  };

  private onWindowMouseUp = (): void => {
    if (!this.dragging) return;
    this.dragging = false;
    window.removeEventListener('mousemove', this.onWindowMouseMove);
    window.removeEventListener('mouseup', this.onWindowMouseUp);
    // Clicking / dragging while playing restarts playback from the new playhead position.
    if (this.wasPlayingBeforeDrag) void this.startPlayback();
    this.wasPlayingBeforeDrag = false;
  };

  /** Map a mouse event to an absolute master time (clamped to the window) and move the playhead. */
  private setPlayheadFromEvent(ev: MouseEvent): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    // Reuse the render code's cssW mapping (backing store is devicePixelRatio-scaled separately).
    const cssW = canvas.clientWidth || rect.width || 1;
    const cssX = ev.clientX - rect.left - (canvas.clientLeft || 0);
    const frac = Math.min(1, Math.max(0, cssX / cssW));
    this.playheadTime = this.mStart + frac * this.WINDOW_SEC;
    this.render();
    // While scrubbing (not playing) the video preview follows the playhead's source-local frame.
    if (!this.isPlaying) this.seekPreviewToPlayhead();
  }

  @HostListener('window:resize')
  onResize(): void { this.render(); }

  // ── Playback (WebAudio) ─────────────────────────────────────────────────────
  async togglePlayback(): Promise<void> {
    if (this.isPlaying) { this.stopPlayback(); this.render(); this.seekPreviewToPlayhead(); return; }
    await this.startPlayback();
  }

  // ── Video preview (the lip-check) ───────────────────────────────────────────
  /**
   * The wizard window is a file:// origin with webSecurity on, so a same-origin file://
   * URL loads directly (the window itself is loaded via file:// — see window-service.ts).
   * Encode each path segment (spaces, #, ? …) while preserving the slashes so the URL is
   * valid; if a file:// preview ever fails to load, the video 'error' handler surfaces it
   * instead of shipping a silent black box.
   */
  private pathToFileUrl(p: string): string {
    return 'file://' + p.split('/').map(encodeURIComponent).join('/');
  }

  /** Point the <video> at the current source and park it at the window center. */
  private updatePreviewVideo(): void {
    const src = this.currentSource;
    const ref = this.previewVideoRef;
    if (!src || src.kind !== 'video' || !ref) return;
    const v = ref.nativeElement;
    v.muted = true;
    v.onerror = () => {
      this.errorMessage = `Could not load preview video: ${src.path}`;
      this.cdr.detectChanges();
    };
    const url = this.pathToFileUrl(src.path);
    if (v.src !== url) {
      v.src = url;
      // Seek to the playhead frame only once metadata (duration/seekable) is available.
      const onMeta = () => { v.removeEventListener('loadedmetadata', onMeta); this.seekPreviewToPlayhead(); };
      v.addEventListener('loadedmetadata', onMeta);
    } else {
      this.seekPreviewToPlayhead();
    }
  }

  /** While NOT playing, park the video at the playhead's source-local frame (scrubbing). */
  private seekPreviewToPlayhead(): void {
    const ref = this.previewVideoRef;
    if (!ref || this.isPlaying || !this.isVideoStep) return;
    // Source-local frame under the playhead is playheadTime - offset (master - offset). Clamp >= 0.
    const t = this.playheadTime - this.currentOffset();
    try { ref.nativeElement.currentTime = Math.max(0, t); } catch { /* not seekable yet */ }
  }

  private async startPlayback(): Promise<void> {
    const src = this.currentSource;
    if (!src) return;
    try {
      if (!this.audioCtx) this.audioCtx = new AudioContext();
      const offset = this.currentOffset();
      // Playback runs from the PLAYHEAD to the window end, not from the window start.
      const pStart = Math.min(this.mStart + this.WINDOW_SEC, Math.max(this.mStart, this.playheadTime));
      const mDuration = (this.mStart + this.WINDOW_SEC) - pStart;
      if (mDuration <= 0.02) return;  // playhead at (or past) the end — nothing to play
      // Desired source-local window start can go NEGATIVE when the offset pushes the
      // window before the source's t=0. ffmpeg cannot seek before 0 (the service clamps),
      // so extract from 0 and DELAY the source node's start by the clamped amount —
      // otherwise the verification playback itself would be silently misaligned by
      // exactly that amount.
      const sDesired = pStart - offset;
      const sDelay = sDesired < 0 ? -sDesired : 0;
      const sDuration = mDuration - sDelay;
      const [m, s] = await Promise.all([
        this.electron.alignmentExtractSamples({
          filePath: this.masterVideo, startSec: pStart, durationSec: mDuration, sampleRate: this.PLAYBACK_SR
        }),
        sDuration > 0
          ? this.electron.alignmentExtractSamples({
              filePath: src.path, startSec: Math.max(0, sDesired), durationSec: sDuration, sampleRate: this.PLAYBACK_SR
            })
          // Source is entirely before the window — nothing of it is audible here;
          // play master alone (truthful, not a fabricated mix).
          : Promise.resolve({ success: true, sampleRate: this.PLAYBACK_SR,
                              samples: new Float32Array(0), error: undefined as string | undefined }),
      ]);
      if (!m?.success || !m.samples) throw new Error(`master segment: ${m?.error || 'failed'}`);
      if (!s?.success || !s.samples) throw new Error(`source segment: ${s?.error || 'failed'}`);

      const ctx = this.audioCtx;
      // Half-gain each so the mix doesn't clip; misalignment is audible as echo/phasing.
      // delays[i] shifts each node's start so the clamped source lines up honestly.
      const nodes: AudioBufferSourceNode[] = [];
      const delays: number[] = [];
      const segs: Array<{ seg: any; delay: number }> = [
        { seg: m, delay: 0 },
        { seg: s, delay: sDelay },
      ];
      for (const { seg, delay } of segs) {
        const arr = seg.samples as Float32Array;
        if (arr.length === 0) continue; // source entirely outside the window
        const buf = ctx.createBuffer(1, arr.length, seg.sampleRate!);
        buf.copyToChannel(arr instanceof Float32Array ? arr : new Float32Array(arr), 0);
        const node = ctx.createBufferSource();
        node.buffer = buf;
        const gain = ctx.createGain();
        gain.gain.value = 0.6;
        node.connect(gain).connect(ctx.destination);
        nodes.push(node);
        delays.push(delay);
      }
      this.activeNodes = nodes;
      this.isPlaying = true;
      // Master (nodes[0]) reaching its end means playback finished: stop the animation and
      // persist the playhead at the window end.
      nodes[0].onended = () => {
        if (this.isPlaying) {
          this.isPlaying = false;
          this.activeNodes = [];
          if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
          this.playheadTime = this.mStart + this.WINDOW_SEC;
          this.render();
          this.cdr.detectChanges();
        }
      };
      const t0 = ctx.currentTime + 0.02;
      nodes.forEach((n, i) => n.start(t0 + delays[i]));

      // Animate the playhead against the audio clock, anchored at pStart / t0.
      this.playbackAnchorCtxTime = t0;
      this.playbackAnchorTime = pStart;
      if (this.rafId !== null) cancelAnimationFrame(this.rafId);
      this.rafId = requestAnimationFrame(this.animatePlayhead);

      // Video lip-check: play the SOURCE video muted, IN SYNC with the mixed audio. The
      // source's own embedded audio is already in the mix (audio path above); the muted
      // video only adds lips. It starts at the source-local window start (sDesired) and is
      // delayed by the SAME clamp amount (sDelay) as the source audio node so both line up.
      // NOTE: HTML5 <video> currentTime runs off a different clock than WebAudio and drifts
      // a little over the 10 s window — acceptable for a lip check (the numeric alignment is
      // the waveform's job, not the video's).
      if (this.currentSource?.kind === 'video' && this.previewVideoRef) {
        const v = this.previewVideoRef.nativeElement;
        v.muted = true;
        const vStart = Math.max(0, sDesired);
        try { v.currentTime = vStart; } catch { /* seek queued until seekable */ }
        const leadSec = (t0 - ctx.currentTime) + sDelay;   // real-time lead to the source's start
        if (this.videoPlayTimer !== null) { clearTimeout(this.videoPlayTimer); }
        this.videoPlayTimer = window.setTimeout(() => {
          this.videoPlayTimer = null;
          if (this.isPlaying) {
            void v.play().catch((e: any) => {
              // A benign pause-race is filtered by the isPlaying guard; a real failure
              // (e.g. the file:// source didn't load) surfaces rather than staying silent.
              if (this.isPlaying) {
                this.errorMessage = `Preview video playback failed: ${e?.message || e}`;
                this.cdr.detectChanges();
              }
            });
          }
        }, Math.max(0, leadSec * 1000));
      }
      this.cdr.detectChanges();
    } catch (err: any) {
      this.isPlaying = false;
      this.errorMessage = `Playback failed: ${err?.message || err}`;
      this.cdr.detectChanges();
    }
  }

  /** rAF loop: advance the playhead by real elapsed audio time from the playback anchor. */
  private animatePlayhead = (): void => {
    if (!this.isPlaying || !this.audioCtx) { this.rafId = null; return; }
    const elapsed = this.audioCtx.currentTime - this.playbackAnchorCtxTime;  // negative before t0
    const t = this.playbackAnchorTime + Math.max(0, elapsed);
    this.playheadTime = Math.min(this.mStart + this.WINDOW_SEC, Math.max(this.mStart, t));
    this.render();
    this.rafId = requestAnimationFrame(this.animatePlayhead);
  };

  private stopPlayback(): void {
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    if (this.videoPlayTimer !== null) { clearTimeout(this.videoPlayTimer); this.videoPlayTimer = null; }
    const v = this.previewVideoRef?.nativeElement;
    if (v) { try { v.pause(); } catch { /* already paused */ } }
    for (const n of this.activeNodes) {
      try { n.onended = null; n.stop(); } catch { /* already stopped */ }
    }
    this.activeNodes = [];
    this.isPlaying = false;
  }

  /** Nudging while playing restarts playback with the new offset (documented choice). */
  private restartPlayback(): void {
    this.stopPlayback();
    void this.startPlayback();
  }

  // ── Finish / fail ────────────────────────────────────────────────────────────
  private async finish(): Promise<void> {
    // Contract: every present source must be completed through both phases, and any
    // residual END nudge is only permissible where the pipeline accepts drift (audio
    // and the screen/cam2 video sources). The linear Next-gating already guarantees
    // this, but verify defensively — we must never send an override the pipeline
    // would reject (cam1 drift).
    const incomplete = this.sources.find(s =>
      !s.startVisited || !s.endVisited || (s.endFrames !== 0 && !this.driftAllowedFor(s)));
    if (incomplete) {
      this.errorMessage = `Cannot finish: ${incomplete.label} still has an unresolved end nudge or was not fully stepped through.`;
      this.cdr.detectChanges();
      return;
    }

    // Zero end nudge => user-verified no drift (explicit driftFactor 1.0, which also
    // bypasses the auto device-drift stretch); a nonzero, accepted nudge => clock-drift
    // factor r sent VERBATIM (audio: resample stretch; screen/cam2 video: manual retime).
    // offsetSeconds is always the START offset (measured seed + start-nudge frames).
    const audioOverrides: { [k: string]: { offsetSeconds: number; driftFactor: number } } = {};
    const videoOverrides: { [k: string]: { offsetSeconds: number; driftFactor: number } } = {};
    for (const src of this.sources) {
      const driftFactor = src.endFrames === 0 ? 1.0 : this.driftFactorFor(src);
      const override = { offsetSeconds: this.offsetStart(src), driftFactor };
      if (src.kind === 'audio') audioOverrides[src.type] = override;
      else videoOverrides[src.type] = override;
    }

    // GAME RULE: the game video has no wizard step. If a game video exists AND the screen
    // video was wizard-aligned here, position game exactly where screen ended up — a COPY
    // of screen's override. If game exists but screen was NOT aligned (no screen video
    // source in the wizard), leave game absent so the pipeline auto-aligns it; copying an
    // unrelated source's offset would be wrong.
    if (this.gamePresent && videoOverrides['screen']) {
      videoOverrides['game'] = { ...videoOverrides['screen'] };
    }

    this.finished = true;
    const overrides: { audio: any; video?: any } = { audio: audioOverrides };
    if (Object.keys(videoOverrides).length > 0) overrides.video = videoOverrides;
    await this.electron.completeAlignment(overrides);
  }

  private fail(message: string): void {
    this.errorMessage = message;
    this.loading = false;
    this.cdr.detectChanges();
  }
}
