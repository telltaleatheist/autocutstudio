import {
  Component, OnInit, OnDestroy, AfterViewInit, ViewChild, ElementRef, HostListener, ChangeDetectorRef
} from '@angular/core';
import { ElectronService } from '../../services/electron.service';
import { EditorManifest, EditorSegment, EditorTrack } from '../../models/editor-manifest';

/**
 * Timeline editor (its own chromeless Electron window).
 *
 * VIEW-ONLY, Final-Cut-Pro-styled review of a processed session's FINAL cut. On init it
 * pulls the zip path (race-free pull + push, mirroring the alignment wizard), asks Python
 * for the flattened manifest, then renders a canvas timeline (ruler + one video track +
 * audio tracks with in-clip waveforms), a video viewer, and element-based jump-cut
 * playback. No editing, no export.
 *
 * Canvas / dpr / playhead / rAF / file-url techniques are copied from
 * alignment.component.ts (which is NOT modified). Numbers are sacred; failures surface
 * verbatim instead of silently degrading (a track whose file will not load STOPS
 * playback and shows the error).
 */

interface Peaks { min: number[]; max: number[]; }

/**
 * Transcript sidecar (`<session>_transcript.json`). Words carry ORIGINAL timeline
 * coordinates (the v1 manifest time base, pre-user-cuts) — the same base the cut list uses,
 * so the frontend maps a word onto the current edited timeline through originalToEdited().
 */
interface TranscriptWord {
  track: string;
  text: string;
  timelineStart: number;   // ORIGINAL seconds
  timelineEnd: number;     // ORIGINAL seconds
  fileStart: number;
  fileEnd: number;
  group: number;           // index of the containing flattened leaf segment on that file
  prob?: number;
}
interface TranscriptTrack { id: string; label: string; file: string; }
interface Transcript {
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
interface TranscriptGroup {
  trackId: string;
  label: string;
  color: string;
  text: string;
  originalStart: number;   // min word timelineStart
  originalEnd: number;     // max word timelineEnd
}
/** A visible group with its cut-aware edited-timeline timecode (recomputed when cuts change). */
interface TranscriptGroupView {
  label: string;
  color: string;
  text: string;
  originalStart: number;   // min word timelineStart (ORIGINAL seconds) — selection lo + seek target
  originalEnd: number;     // max word timelineEnd (ORIGINAL seconds) — selection hi
  timecode: string;
}
/** Transcript pane lifecycle: button / progress+cancel / preview / verbatim error. */
type TranscriptState = 'none' | 'running' | 'ready' | 'error';

/**
 * A recent session row, shared byte-for-byte with the launcher via the
 * 'editor.recentSessions' localStorage key. name = filename minus _compounds.zip.
 */
interface RecentSession {
  zipPath: string;
  name: string;
  lastOpened: string; // ISO date
}

/** Timeline pointer tool: Arrow (scrub/select) or Blade (drop section boundaries). */
type ToolMode = 'select' | 'blade';

/**
 * A cut is a half-open FRAME range in ORIGINAL timeline coordinates (the manifest's time
 * base, before any edits). 0 <= startFrame < endFrame. Cut lists are kept sorted ascending
 * and non-overlapping (adjacent cuts merged). This is the single source of edit truth.
 */
export interface Cut { startFrame: number; endFrame: number; }

/**
 * One kept interval of the timeline after cuts are applied. `os`/`oe` are the interval's
 * bounds in ORIGINAL seconds; `es`/`ee` are the same span mapped into EDITED seconds (the
 * ripple just shifts it left, so ee - es === oe - os). Sorted ascending in both domains, so
 * both maps are binary-searchable.
 */
interface KeptInterval { os: number; oe: number; es: number; ee: number; }

/** Vertical layout of a track lane inside the canvas (CSS px, canvas-local). */
interface TrackRow {
  track: EditorTrack;
  top: number;
  height: number;
}

@Component({
  selector: 'app-editor',
  standalone: false,
  templateUrl: './editor.component.html',
  styleUrl: './editor.component.scss'
})
export class EditorComponent implements OnInit, AfterViewInit, OnDestroy {
  // ── FCP visual constants (CSS px) ───────────────────────────────────────────
  readonly GUTTER_W = 110;      // left track-header column
  private readonly RULER_H = 26;
  private readonly VIDEO_TRACK_H = 62;
  private readonly AUDIO_TRACK_H = 54;
  private readonly CLIP_INSET_Y = 4;   // vertical padding of a clip inside its lane
  private readonly CLIP_RADIUS = 4;

  // Zoom (pixels per timeline second) clamp.
  private readonly ZOOM_MIN = 1;
  private readonly ZOOM_MAX = 600;

  // Playback / scrub sync tolerance (seconds) before we re-seek an element.
  private readonly SEEK_TOLERANCE = 0.08;

  // Waveform bucketing: ~2 buckets per CSS px of the clip's on-screen width, capped.
  private readonly BUCKETS_PER_PX = 2;
  private readonly MAX_BUCKETS = 4000;
  private readonly MIN_BUCKETS = 8;
  // A clip narrower than this shows no meaningful waveform — draw plain fill and do
  // NOT request peaks. Without this, a zoomed-out timeline with ~2k clips would fire
  // an ffmpeg extraction per clip on first paint.
  private readonly MIN_WAVEFORM_PX = 6;
  // Peak extractions each spawn an ffmpeg process in the main process — cap how many
  // run at once; the rest queue.
  private readonly MAX_CONCURRENT_PEAKS = 4;

  @ViewChild('timelineCanvas') canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('viewerVideo') viewerVideoRef!: ElementRef<HTMLVideoElement>;
  @ViewChild('topRegion') topRegionRef?: ElementRef<HTMLElement>;

  // ── Resizable layout (FCPX-style panes) ─────────────────────────────────────
  // splitV: fraction of the top region's WIDTH given to the transcript (left) pane.
  // splitH: fraction of the window HEIGHT given to the timeline pane.
  // UI preferences, not sacred data: corrupt/missing stored values fall back to the
  // defaults and out-of-range values are clamped.
  private readonly SPLIT_V_KEY = 'editor.splitV';
  private readonly SPLIT_H_KEY = 'editor.splitH';
  private readonly SPLIT_V_MIN = 0.2;
  private readonly SPLIT_V_MAX = 0.8;
  private readonly SPLIT_V_DEFAULT = 0.5;
  private readonly SPLIT_H_MIN = 0.2;
  private readonly SPLIT_H_MAX = 0.6;
  private readonly SPLIT_H_DEFAULT = 0.4;
  // splitP: the project-picker column WIDTH in px (fixed, not a fraction — the far-left
  // FCPX-libraries column). Clamped; corrupt/missing falls back to the default.
  private readonly SPLIT_P_KEY = 'editor.splitP';
  private readonly SPLIT_P_MIN = 140;
  private readonly SPLIT_P_MAX = 360;
  private readonly SPLIT_P_DEFAULT = 200;
  private readonly SPLITTER_PX = 6;        // matches .splitter flex-basis in the SCSS
  splitV = this.SPLIT_V_DEFAULT;
  splitH = this.SPLIT_H_DEFAULT;
  projectWidth = this.SPLIT_P_DEFAULT;
  draggingSplitV = false;  // public: template highlights the splitter while dragging
  draggingSplitH = false;
  draggingSplitP = false;

  // ── Load / error state ──────────────────────────────────────────────────────
  loading = true;
  loadingMessage = 'Loading…';
  errorMessage = '';        // fatal, full-screen error (nothing else interactive)
  transportError = '';      // non-fatal-to-render but playback-stopping (shown in transport)
  manifest: EditorManifest | null = null;

  // ── Timeline view state ─────────────────────────────────────────────────────
  pxPerSec = 20;            // zoom
  private scrollOffset = 0; // seconds at the left edge of the visible track area
  playheadTime = 0;         // seconds

  // ORIGINAL segments grouped + sorted per track (built once from the manifest, immutable
  // source for every rebuild).
  private originalSegsByTrack = new Map<string, EditorSegment[]>();
  // EDITED segments grouped + sorted per track: the manifest segments with the current cuts
  // removed and rippled left. THE EDITED MODEL IS THE VIEW — all rendering, scrubbing,
  // playback, timecode, scrollbar and zoom-fit read this (and editedDuration), never the raw
  // manifest. With zero cuts it is byte-for-byte the manifest (identity maps).
  private segsByTrack = new Map<string, EditorSegment[]>();
  // Video tracks in MANIFEST order: index 0 is the primary camera storyline, the rest
  // are overlay/background layers. Only the primary drives the viewer (v1 is not a
  // compositor); overlays render on the timeline only.
  private videoTrackIds: string[] = [];
  private audioTrackIds: string[] = [];
  private get primaryVideoTrackId(): string | null {
    return this.videoTrackIds.length > 0 ? this.videoTrackIds[0] : null;
  }

  // The zip currently loaded (or being loaded). Guards duplicate payload pushes and
  // enables full re-init when the launcher opens a DIFFERENT session into this window.
  private currentZipPath: string | null = null;
  // Monotonic bootstrap generation: a re-init mid-load invalidates the older load so a
  // slow stale manifest can never clobber the newer session.
  private bootstrapGeneration = 0;

  // ── Edit model (cuts → edited timeline) ─────────────────────────────────────
  // `cuts` is the single source of edit truth (frames, ORIGINAL coords, sorted+merged).
  // Everything derived (segsByTrack above, editedDuration, keptIntervals) is rebuilt from it.
  cuts: Cut[] = [];
  editedDuration = 0;                    // seconds; == manifest.timelineDuration with zero cuts
  private keptIntervals: KeptInterval[] = [];
  private readonly UNDO_LIMIT = 100;
  private undoStack: Cut[][] = [];       // snapshots of prior cut lists (immutable arrays)
  private redoStack: Cut[][] = [];
  private readonly EPS = 1e-9;           // seconds; sub-frame slop for interval intersection

  // ── Selection (EDITED seconds; either edge may be pending/null) ──────────────
  selStart: number | null = null;        // 'i' mark / drag start
  selEnd: number | null = null;          // 'o' mark / drag end
  private draggingSelection = false;

  // Committed multi-selection (EDITED seconds) — the selection source of truth. Single-range
  // actions (section click, group click, I/O marks, shift-paint) live in selStart/selEnd and
  // clear this; a marquee writes N ranges here and clears selStart/selEnd. drawSelection and
  // deleteSelection operate on the UNION of both (allSelectionRanges), so a list of ranges works
  // everywhere a single range used to.
  private selectedRanges: { start: number; end: number }[] = [];
  // Marquee gesture (SELECT-tool drag that starts in a track lane). marqueeMoved distinguishes a
  // real drag (→ marquee) from a plain click (→ scrub + section select).
  private marqueeActive = false;
  private marqueeMoved = false;
  private marqueeStartTime = 0;          // EDITED seconds
  private marqueeEndTime = 0;            // EDITED seconds

  // ── Tools + blade (FCPX Arrow / Blade) ──────────────────────────────────────
  // The active pointer tool. Blade drops boundaries that subdivide the timeline into
  // sections; clicking a section (either tool) selects it for a ripple delete.
  toolMode: ToolMode = 'select';
  // Blade boundaries in ORIGINAL timeline seconds, so they survive cuts via
  // originalToEdited() (a boundary swallowed by a cut collapses to its seam and is pruned).
  // Sorted ascending, de-duplicated. Cleared on session re-init.
  private bladeBoundaries: number[] = [];

  // The transcript group (identified by its ORIGINAL span) currently reflected in the
  // timeline selection — drives the pane's SELECTED highlight. Cleared whenever the
  // selection is set by any non-group action or is cleared.
  private selectedGroupStart: number | null = null;
  private selectedGroupEnd: number | null = null;

  // ── Export ──────────────────────────────────────────────────────────────────
  exporting = false;
  exportResultPath: string | null = null; // set on a successful FCPXML export
  exportError: string | null = null;       // Python's message, verbatim, on failure
  // Top-bar File menu (Export / Open) open/closed state.
  menuOpen = false;

  // ── Transcript ────────────────────────────────────────────────────────────
  // Stable per-track-id color, assigned by discovery order and cycled for extra tracks.
  private readonly TRACK_COLORS = ['#e8a33d', '#4a9eff', '#7bc98f', '#c98fd6', '#d67b7b', '#7bd6cf'];
  transcriptState: TranscriptState = 'none';
  private transcript: Transcript | null = null;
  // All groups in timeline order (immutable per loaded transcript). visibleGroups is the
  // cut-aware, timecoded projection the template renders — recomputed whenever cuts change.
  private transcriptGroups: TranscriptGroup[] = [];
  visibleGroups: TranscriptGroupView[] = [];
  transcriptWordCount = 0;
  transcriptError = '';                       // verbatim failure message (Python's or a parse error)
  // Running-job UI + the id used to filter progress/complete events against stale sessions.
  private transcribeJobId: string | null = null;
  transcribeProgress = 0;                     // 0-100 int
  transcribeMessage = '';
  transcribeEtaSeconds: number | null = null; // measured time-remaining; null = still estimating
  // Source filter + free-text search over the transcript. sourceFilter is a track id or
  // 'merged'; default (set on ingest) is the FIRST track (the mic). Both reset on re-init
  // and are pure recomputes over recomputeVisibleGroups.
  transcriptTracks: { id: string; label: string }[] = [];
  sourceFilter = 'merged';
  searchQuery = '';

  // ── Project picker (far-left FCPX-libraries column) ─────────────────────────
  // Shares 'editor.recentSessions' with the launcher (same shape, prune, sort).
  private readonly RECENTS_KEY = 'editor.recentSessions';
  private readonly COMPOUNDS_SUFFIX = '_compounds.zip';
  recents: RecentSession[] = [];

  // ── Rendering ───────────────────────────────────────────────────────────────
  private renderScheduled = false;

  // ── Waveform cache ──────────────────────────────────────────────────────────
  private peaksCache = new Map<string, Peaks>();
  private peaksInFlight = new Set<string>();
  private peaksActive = 0;
  private peaksQueue: Array<() => Promise<void>> = [];

  // ── Playback ────────────────────────────────────────────────────────────────
  isPlaying = false;
  private rafId: number | null = null;
  private playAnchorPerfMs = 0;   // performance.now() at play start
  private playAnchorTime = 0;     // timeline seconds the clock started from
  // One <audio> per distinct audio-track FILE (created lazily). The viewer <video>
  // handles the single video track.
  private audioEls = new Map<string, HTMLAudioElement>();
  private viewerLoadedFile: string | null = null;

  // Drag-scrub state (stable listener refs so removal always matches add).
  private draggingPlayhead = false;
  private draggingScrollbar = false;
  private scrollbarGrabDx = 0;

  constructor(private electron: ElectronService, private cdr: ChangeDetectorRef) {}

  // ── Lifecycle ───────────────────────────────────────────────────────────────
  async ngOnInit(): Promise<void> {
    // Restore pane-split preferences (validated + clamped; fall back on anything odd).
    this.splitV = this.readSplit(this.SPLIT_V_KEY, this.SPLIT_V_MIN, this.SPLIT_V_MAX, this.SPLIT_V_DEFAULT);
    this.splitH = this.readSplit(this.SPLIT_H_KEY, this.SPLIT_H_MIN, this.SPLIT_H_MAX, this.SPLIT_H_DEFAULT);
    this.projectWidth = this.readSplit(this.SPLIT_P_KEY, this.SPLIT_P_MIN, this.SPLIT_P_MAX, this.SPLIT_P_DEFAULT);
    // Recents (pruned against disk) drive the project picker; shared with the launcher.
    void this.loadAndPruneRecents();
    // Race-free pull + push, like the alignment wizard — but the push listener is
    // PERMANENT: when this window is already open on a session and the launcher opens a
    // DIFFERENT one, the main process pushes the new payload over the same channel
    // without a page reload, and we fully re-initialize onto it. A push carrying the
    // zipPath we already have (or are already loading) is the belt-and-suspenders
    // duplicate of the pull — ignored.
    this.electron.onEditorPayload((p) => {
      if (!p?.zipPath) return;
      if (p.zipPath === this.currentZipPath) return;
      void this.bootstrap(p.zipPath);
    });
    // Transcription job events. Registered ONCE (like onEditorPayload) and kept for the
    // window's life; every event is filtered against the CURRENT job id so a stale job's
    // progress/completion (from a superseded session) can never touch live UI.
    this.electron.onTranscribeProgress((d) => this.onTranscribeProgress(d));
    this.electron.onTranscribeComplete((d) => this.onTranscribeComplete(d));
    try {
      const res = await this.electron.getEditorPayload();
      if (res?.zipPath && res.zipPath !== this.currentZipPath) {
        await this.bootstrap(res.zipPath);
      } else if (!res?.zipPath && !this.currentZipPath) {
        // Payload may still arrive via the push listener; keep the busy state.
        this.loadingMessage = 'Waiting for session…';
      }
    } catch (err: any) {
      this.fail(`Could not load the session: ${err?.message || err}`);
    }
  }

  ngAfterViewInit(): void {
    this.requestRender();
  }

  ngOnDestroy(): void {
    this.stopPlayback();
    window.removeEventListener('mousemove', this.onWindowMouseMove);
    window.removeEventListener('mouseup', this.onWindowMouseUp);
    document.body.style.userSelect = ''; // in case we're destroyed mid-splitter-drag
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    for (const el of this.audioEls.values()) { try { el.pause(); el.src = ''; } catch { /* gone */ } }
    this.audioEls.clear();
    this.electron.removeEditorListeners();
    this.electron.removeTranscribeListeners();
  }

  // ── Bootstrap: (re)load a session's manifest ────────────────────────────────
  /**
   * Loads `zipPath` into this window. Called on first init AND whenever the launcher
   * pushes a different session into the already-open window — so it always starts by
   * releasing every trace of the previous session (playback, caches, media elements).
   * A generation counter invalidates any slower load still in flight.
   */
  private async bootstrap(zipPath: string): Promise<void> {
    const generation = ++this.bootstrapGeneration;
    this.currentZipPath = zipPath;
    this.resetSessionState();
    this.loading = true;
    this.loadingMessage = 'Reading timeline…';
    this.cdr.detectChanges();
    let manifest: EditorManifest;
    try {
      manifest = await this.electron.getEditorManifest(zipPath);
    } catch (err: any) {
      if (generation !== this.bootstrapGeneration) return; // superseded by a newer load
      // Python's error message is authoritative — show it verbatim.
      this.fail(err?.message || String(err));
      return;
    }
    if (generation !== this.bootstrapGeneration) return; // superseded by a newer load
    try {
      this.ingestManifest(manifest);
    } catch (err: any) {
      this.fail(err?.message || String(err));
      return;
    }
    this.loading = false;
    // Remember this session in the shared recents (updates lastOpened + re-sorts), so the
    // project picker always shows the currently-loaded one highlighted at the top.
    this.recordRecent(zipPath);
    this.cdr.detectChanges();
    // Fit the whole timeline into the visible width on first render.
    this.initialZoomToFit();
    this.playheadTime = 0;
    this.seekViewerToPlayhead();
    this.requestRender();
    // The sidecar (if any) is the source of truth for the transcript: null → state 1
    // (Transcribe button), parsed → state 3 (preview). Loaded async so it never blocks
    // first paint; generation-guarded so a slow read can't land on a newer session.
    void this.loadTranscriptForSession(zipPath, generation);
  }

  /** Release ALL per-session state so a re-init cannot leak the previous session. */
  private resetSessionState(): void {
    this.stopPlayback();
    // Old audio elements must not keep playing (or even keep their file handles): pause,
    // detach the source, and drop them; new ones are created lazily for the new session.
    for (const el of this.audioEls.values()) {
      try { el.pause(); el.removeAttribute('src'); el.load(); } catch { /* gone */ }
    }
    this.audioEls.clear();
    const v = this.viewerVideoRef?.nativeElement;
    if (v) {
      try { v.pause(); v.removeAttribute('src'); v.load(); } catch { /* gone */ }
    }
    this.viewerLoadedFile = null;
    this.manifest = null;
    this.originalSegsByTrack.clear();
    this.segsByTrack.clear();
    this.videoTrackIds = [];
    this.audioTrackIds = [];
    this.peaksCache.clear();
    this.peaksInFlight.clear();
    this.peaksQueue = [];   // queued (not yet started) extractions for the old session
    this.playheadTime = 0;
    this.scrollOffset = 0;
    this.errorMessage = '';
    this.transportError = '';
    // Edit state: a re-init starts the new session with an untouched timeline.
    this.cuts = [];
    this.keptIntervals = [];
    this.editedDuration = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.selStart = null;
    this.selEnd = null;
    this.draggingSelection = false;
    this.selectedRanges = [];
    this.marqueeActive = false;
    this.marqueeMoved = false;
    // Blade boundaries + transcript-derived selection are per-session; drop them so a
    // re-init cannot leak a previous session's carve marks.
    this.bladeBoundaries = [];
    this.selectedGroupStart = null;
    this.selectedGroupEnd = null;
    this.exporting = false;
    this.exportResultPath = null;
    this.exportError = null;
    this.menuOpen = false;
    // Transcript: a re-init starts fresh. An in-flight job for the OLD session is
    // actively cancelled — a multi-hour whisper run must not keep burning CPU for a
    // session nobody is looking at (dropping the job id alone would only mute its
    // events). Cancellation is best-effort fire-and-forget; the jobId guard below
    // still ignores any straggler events. Listeners persist for the window's life
    // (removed in ngOnDestroy).
    if (this.transcribeJobId) {
      void this.electron.cancelTranscription({ jobId: this.transcribeJobId });
    }
    this.transcript = null;
    this.transcriptGroups = [];
    this.visibleGroups = [];
    this.transcriptTracks = [];
    this.sourceFilter = 'merged';
    this.searchQuery = '';
    this.transcriptWordCount = 0;
    this.transcriptState = 'none';
    this.transcriptError = '';
    this.transcribeJobId = null;
    this.transcribeProgress = 0;
    this.transcribeMessage = '';
    this.transcribeEtaSeconds = null;
  }

  /** Validate and index the manifest. Fails loud on anything structurally wrong. */
  private ingestManifest(m: EditorManifest): void {
    if (!m || typeof m !== 'object') throw new Error('Editor manifest was empty or malformed.');
    if (!Array.isArray(m.tracks) || m.tracks.length === 0) throw new Error('Editor manifest has no tracks.');
    if (!Array.isArray(m.segments)) throw new Error('Editor manifest has no segments array.');
    if (!(m.frameSeconds > 0)) throw new Error(`Editor manifest has an invalid frameSeconds: ${m.frameSeconds}`);
    if (!(m.timelineDuration > 0)) throw new Error(`Editor manifest has an invalid timelineDuration: ${m.timelineDuration}`);

    const videoTracks = m.tracks.filter(t => t.kind === 'video');
    if (videoTracks.length === 0) {
      throw new Error('Editor manifest has no video track.');
    }

    this.manifest = m;
    // Manifest order is authoritative: the FIRST video track is the primary camera
    // storyline; any further video tracks are overlay/background layers.
    this.videoTrackIds = videoTracks.map(t => t.id);
    this.audioTrackIds = m.tracks.filter(t => t.kind === 'audio').map(t => t.id);

    this.originalSegsByTrack.clear();
    for (const t of m.tracks) this.originalSegsByTrack.set(t.id, []);
    for (const seg of m.segments) {
      const arr = this.originalSegsByTrack.get(seg.trackId);
      if (!arr) throw new Error(`Segment references unknown track "${seg.trackId}".`);
      arr.push(seg);
    }
    for (const arr of this.originalSegsByTrack.values()) {
      arr.sort((a, b) => a.timelineStart - b.timelineStart);
    }
    // With cuts empty (always, right after ingest) this builds the identity edited model:
    // segsByTrack === the manifest segments, editedDuration === timelineDuration.
    this.rebuildEditedModel();
  }

  // ── Edited model + piecewise time maps ──────────────────────────────────────
  /**
   * Rebuild every derived edit artifact from `cuts`: the kept-interval list, editedDuration,
   * the per-track edited segments, and (implicitly) the editedToOriginal/originalToEdited
   * maps that read keptIntervals. A manifest segment [ts, ts+d) is intersected with each kept
   * interval; every non-empty intersection is one edited segment whose sourceStart carries the
   * offset into the media file, so jump-cut playback across removed ranges is automatic.
   */
  private rebuildEditedModel(): void {
    const m = this.manifest;
    if (!m) { this.keptIntervals = []; this.editedDuration = 0; this.segsByTrack.clear(); return; }
    const dur = m.timelineDuration;
    const fs = m.frameSeconds;

    // Kept intervals = the complement of the cuts within [0, dur], each carrying its rippled
    // edited-space start. cuts are sorted+merged, so a single left-to-right walk suffices.
    const kept: KeptInterval[] = [];
    let cursor = 0, acc = 0;
    for (const c of this.cuts) {
      const cs = c.startFrame * fs;
      const ce = c.endFrame * fs;
      if (cs > cursor + this.EPS) {
        const len = cs - cursor;
        kept.push({ os: cursor, oe: cs, es: acc, ee: acc + len });
        acc += len;
      }
      if (ce > cursor) cursor = ce;
    }
    if (dur > cursor + this.EPS) {
      const len = dur - cursor;
      kept.push({ os: cursor, oe: dur, es: acc, ee: acc + len });
      acc += len;
    }
    this.keptIntervals = kept;
    this.editedDuration = acc;

    // Split each original segment against the kept intervals.
    this.segsByTrack.clear();
    for (const [trackId, segs] of this.originalSegsByTrack) {
      const out: EditorSegment[] = [];
      for (const seg of segs) {
        const ts = seg.timelineStart;
        const te = ts + seg.duration;
        for (const iv of kept) {
          if (iv.os >= te) break;          // kept intervals are sorted; nothing further overlaps
          if (iv.oe <= ts) continue;
          const os = Math.max(ts, iv.os);
          const oe = Math.min(te, iv.oe);
          if (oe - os <= this.EPS) continue;
          out.push({
            trackId: seg.trackId,
            timelineStart: iv.es + (os - iv.os),   // rippled position
            duration: oe - os,
            file: seg.file,
            sourceStart: seg.sourceStart + (os - ts),
            label: seg.label,
          });
        }
      }
      // Output is already sorted (segs sorted, kept sorted, non-overlapping).
      this.segsByTrack.set(trackId, out);
    }
    // Transcript group visibility + edited timecodes depend on the cut model — re-derive
    // them here so they stay in lockstep with every cut/undo/redo (no-op before load).
    this.recomputeVisibleGroups();
  }

  /** EDITED seconds → ORIGINAL seconds (piecewise, binary-searched over keptIntervals). */
  private editedToOriginal(e: number): number {
    const iv = this.keptIntervals;
    if (iv.length === 0) return 0;
    const t = Math.min(this.editedDuration, Math.max(0, e));
    let lo = 0, hi = iv.length - 1, idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (iv[mid].es <= t) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return iv[idx].os + (t - iv[idx].es);
  }

  /**
   * ORIGINAL seconds → EDITED seconds. A time inside a removed range collapses to that cut's
   * seam (the edited position where the removed content used to begin), which is exactly the
   * landing spot after a ripple delete.
   */
  private originalToEdited(t: number): number {
    const iv = this.keptIntervals;
    if (iv.length === 0) return 0;
    const c = Math.min(this.manifest?.timelineDuration || 0, Math.max(0, t));
    let lo = 0, hi = iv.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (iv[mid].os <= c) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (idx < 0) return iv[0].es;               // c precedes the first kept interval (leading cut)
    if (c <= iv[idx].oe) return iv[idx].es + (c - iv[idx].os);
    return iv[idx].ee;                          // c is in a cut that follows this kept interval
  }

  private fail(message: string): void {
    this.errorMessage = message;
    this.loading = false;
    this.stopPlayback();
    this.cdr.detectChanges();
  }

  // ── Track layout (shared by canvas draw + the DOM gutter) ────────────────────
  /**
   * FCP-style stacking. Row order top → bottom:
   *   videoTracks[n-1] … videoTracks[1]   (overlay/background layers, like FCP's
   *                                        connected clips — later manifest index sits
   *                                        higher on screen)
   *   videoTracks[0]                      (PRIMARY storyline, bottom of the video group)
   *   audio tracks in manifest order      (below the primary, unchanged)
   * i.e. the video group is the manifest's video-track list REVERSED, so the primary
   * lands directly above the audio tracks.
   */
  get trackRows(): TrackRow[] {
    const rows: TrackRow[] = [];
    if (!this.manifest) return rows;
    const videoTracks = this.manifest.tracks.filter(t => t.kind === 'video');
    const audioTracks = this.manifest.tracks.filter(t => t.kind === 'audio');
    const ordered = [...videoTracks].reverse().concat(audioTracks);
    // FCPX-style: center the whole track stack in the area below the ruler, so short
    // stacks float in the middle instead of hugging the top. The offset is baked into
    // every row's `top`, so canvas draw + gutter (which both read trackRows / the same
    // offset getter) stay pixel-aligned.
    let y = this.RULER_H + this.trackTopOffset;
    for (const track of ordered) {
      const height = track.kind === 'video' ? this.VIDEO_TRACK_H : this.AUDIO_TRACK_H;
      rows.push({ track, top: y, height });
      y += height;
    }
    return rows;
  }

  /** Total height (CSS px) of the stacked track lanes, ruler excluded. */
  private trackStackHeight(): number {
    if (!this.manifest) return 0;
    let h = 0;
    for (const t of this.manifest.tracks) {
      h += t.kind === 'video' ? this.VIDEO_TRACK_H : this.AUDIO_TRACK_H;
    }
    return h;
  }

  /**
   * Vertical offset (CSS px) that centers the track stack below the ruler: half the empty
   * space when the stack is shorter than the available area, else 0 (it scrolls/clips from
   * the top as before). Read by canvas draw (via trackRows), hit-testing (rowAtY, via
   * trackRows) and the DOM gutter (an offset spacer of this height) — one source of truth.
   */
  get trackTopOffset(): number {
    const c = this.canvasRef?.nativeElement;
    const H = c ? (c.clientHeight || 0) : 0;
    const avail = H - this.RULER_H;
    const stack = this.trackStackHeight();
    return avail > stack ? Math.floor((avail - stack) / 2) : 0;
  }

  // ── Coordinate mapping ──────────────────────────────────────────────────────
  private get viewportWidth(): number {
    const c = this.canvasRef?.nativeElement;
    return c ? (c.clientWidth || 1) : 1;
  }
  private get viewportSec(): number {
    return this.viewportWidth / this.pxPerSec;
  }
  private timeToX(t: number): number {
    return (t - this.scrollOffset) * this.pxPerSec;
  }
  private xToTime(x: number): number {
    return this.scrollOffset + x / this.pxPerSec;
  }
  /**
   * Over-scroll breathing room so the first/last clips aren't jammed against the edges:
   * allow a small pad before 0 and past (editedDuration - viewport). The pad is small
   * (<= 2s, and <= 15% of the visible span). initialZoomToFit still fits [0, editedDuration]
   * exactly — the margin is a clamp relaxation only, never baked into the fit.
   */
  private overscrollMargin(): number {
    return Math.min(2, 0.15 * this.viewportSec);
  }
  private clampScroll(v: number): number {
    const margin = this.overscrollMargin();
    const max = Math.max(0, this.editedDuration - this.viewportSec) + margin;
    return Math.min(max, Math.max(-margin, v));
  }

  private initialZoomToFit(): void {
    const dur = this.editedDuration;
    if (dur <= 0) return;
    const w = this.viewportWidth;
    this.pxPerSec = this.clampZoom(w / dur);
    this.scrollOffset = 0;
  }
  private clampZoom(v: number): number {
    return Math.min(this.ZOOM_MAX, Math.max(this.ZOOM_MIN, v));
  }

  // ── Segment lookup (binary search over sorted segments) ─────────────────────
  private segmentAt(trackId: string, t: number): EditorSegment | null {
    const arr = this.segsByTrack.get(trackId);
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

  // ── Rendering (rAF-batched) ─────────────────────────────────────────────────
  private requestRender(): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    requestAnimationFrame(() => { this.renderScheduled = false; this.draw(); });
  }

  private draw(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas || !this.manifest) return;
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

    const rows = this.trackRows;

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
    const bladeEdited = this.bladeBoundaries.map(b => this.originalToEdited(b));

    // Clips. Each clip is split into sub-pieces at any blade boundary that falls strictly
    // inside it, so a cut reads as a real clip division (in EVERY lane) rather than an overlay
    // line. With no interior boundary a clip renders as a single piece (identity behavior).
    for (const row of rows) {
      const segs = this.segsByTrack.get(row.track.id) || [];
      for (const seg of segs) {
        const x0 = this.timeToX(seg.timelineStart);
        const x1 = this.timeToX(seg.timelineStart + seg.duration);
        if (x1 < 0 || x0 > W) continue; // off-screen
        this.drawClipPieces(ctx, seg, row, W, bladeEdited);
      }
    }

    // Ruler last-but-one so clips never bleed over it.
    this.drawRuler(ctx, W);

    // Selection overlay tints ruler + tracks; playhead draws on top of it.
    this.drawSelection(ctx, W, H);

    // Playhead over everything (ruler + tracks).
    this.drawPlayhead(ctx, W, H);
  }

  /**
   * FCP-style range selection: a translucent yellow fill across ruler + tracks with 1px edges
   * and small ruler handles. A one-sided pending mark ('i' or 'o' alone) shows a yellow flag.
   */
  private drawSelection(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    // Every selected range (committed marquee ranges ∪ the in-progress single range) as a
    // translucent yellow band with 1px edges + ruler handles.
    const ranges = this.allSelectionRanges();
    for (const range of ranges) {
      const x0 = this.timeToX(range.lo);
      const x1 = this.timeToX(range.hi);
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
      ctx.fillRect(x0 - 3, 0, 6, this.RULER_H);
      ctx.fillRect(x1 - 3, 0, 6, this.RULER_H);
      ctx.restore();
    }

    // In-progress marquee rectangle (translucent), spanning the track area under the ruler.
    if (this.marqueeActive && this.marqueeMoved) {
      const mx0 = this.timeToX(Math.min(this.marqueeStartTime, this.marqueeEndTime));
      const mx1 = this.timeToX(Math.max(this.marqueeStartTime, this.marqueeEndTime));
      const top = this.RULER_H;
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
      const one = this.selStart != null ? this.selStart : (this.selEnd != null ? this.selEnd : null);
      if (one == null) return;
      const x = this.timeToX(one);
      if (x < -1 || x > W + 1) return;
      ctx.save();
      ctx.fillStyle = '#f5c518';
      ctx.fillRect(x - 0.5, 0, 1, this.RULER_H);
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
   * The whole selection as normalized [lo, hi] edited-second ranges: the committed marquee
   * ranges (selectedRanges) unioned with the in-progress single range (selStart/selEnd), sorted
   * and merged so overlaps/adjacencies coalesce. Empty when nothing is selected.
   */
  private allSelectionRanges(): { lo: number; hi: number }[] {
    const ranges: { lo: number; hi: number }[] = [];
    for (const r of this.selectedRanges) {
      const lo = Math.min(r.start, r.end);
      const hi = Math.max(r.start, r.end);
      if (hi - lo > this.EPS) ranges.push({ lo, hi });
    }
    const single = this.selRange();
    if (single) ranges.push(single);
    return this.mergeRanges(ranges);
  }

  /** Sort + merge [lo,hi] ranges, coalescing any that overlap or touch. */
  private mergeRanges(ranges: { lo: number; hi: number }[]): { lo: number; hi: number }[] {
    if (ranges.length <= 1) return ranges;
    const sorted = [...ranges].sort((a, b) => a.lo - b.lo);
    const out: { lo: number; hi: number }[] = [{ ...sorted[0] }];
    for (let i = 1; i < sorted.length; i++) {
      const cur = out[out.length - 1];
      const nx = sorted[i];
      if (nx.lo <= cur.hi + this.EPS) cur.hi = Math.max(cur.hi, nx.hi);
      else out.push({ ...nx });
    }
    return out;
  }

  /** Clear every trace of the current selection (single, marquee, and group highlight). */
  private clearSelection(): void {
    this.selStart = null;
    this.selEnd = null;
    this.selectedRanges = [];
    this.selectedGroupStart = null;
    this.selectedGroupEnd = null;
  }

  /**
   * Commit an in-progress marquee: select every SECTION (bounded by sectionBoundaries = clip
   * edges ∪ blades) whose span intersects the dragged time range, snap to those boundaries, and
   * merge adjacent selected sections into contiguous ranges. Overwrites selectedRanges.
   */
  private commitMarquee(): void {
    const lo = Math.min(this.marqueeStartTime, this.marqueeEndTime);
    const hi = Math.max(this.marqueeStartTime, this.marqueeEndTime);
    const bounds = this.sectionBoundaries();
    const hits: { lo: number; hi: number }[] = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const s = bounds[i];
      const e = bounds[i + 1];
      if (e - s <= this.EPS) continue;
      // Section [s,e] intersects the marquee [lo,hi] (endpoints-only touch excluded via EPS).
      if (s < hi - this.EPS && e > lo + this.EPS) hits.push({ lo: s, hi: e });
    }
    const merged = this.mergeRanges(hits);
    this.selectedRanges = merged.map(r => ({ start: r.lo, end: r.hi }));
    this.selStart = null;
    this.selEnd = null;
    this.selectedGroupStart = null;
    this.selectedGroupEnd = null;
  }

  /**
   * Draw one segment as a clip, split into sub-pieces at every blade boundary (already mapped
   * to EDITED seconds) that falls strictly inside its [timelineStart, timelineStart+duration]
   * span. Each piece is its own rounded clip separated by a ~2px gap, so a cut looks like a real
   * edit — the clip is divided — instead of an overlay line, and it divides EVERY lane the same
   * way because every lane's clips are split against the same boundary set. A clip with no
   * interior boundary is a single piece (byte-for-byte the old rendering).
   */
  private drawClipPieces(ctx: CanvasRenderingContext2D, seg: EditorSegment,
                         row: TrackRow, W: number, bladeEdited: number[]): void {
    const ts = seg.timelineStart;
    const te = seg.timelineStart + seg.duration;
    // Interior split points, ascending. Strictly inside → a touching boundary is a clip edge
    // already and must not spawn a zero-width sliver.
    const interior: number[] = [];
    for (const b of bladeEdited) {
      if (b > ts + this.EPS && b < te - this.EPS) interior.push(b);
    }
    interior.sort((a, b) => a - b);
    const edges = [ts, ...interior, te];
    const GAP = 2;             // px of empty space between adjacent pieces
    for (let i = 0; i < edges.length - 1; i++) {
      let px0 = this.timeToX(edges[i]);
      let px1 = this.timeToX(edges[i + 1]);
      if (i > 0) px0 += GAP / 2;                       // inset the shared edge to open the gap
      if (i < edges.length - 2) px1 -= GAP / 2;
      if (px1 - px0 <= 0.5) continue;                  // piece collapsed by the gap at this zoom
      if (px1 < 0 || px0 > W) continue;                // off-screen piece
      if (row.track.kind === 'video') this.drawVideoClip(ctx, seg, px0, px1, row);
      else this.drawAudioClip(ctx, seg, px0, px1, row, W);
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
    const top = row.top + this.CLIP_INSET_Y;
    const h = row.height - 2 * this.CLIP_INSET_Y;
    const w = x1 - x0;

    ctx.save();
    this.roundRectPath(ctx, x0, top, w, h, this.CLIP_RADIUS);
    ctx.fillStyle = '#5a6b8c';
    ctx.fill();
    // Subtle top highlight.
    ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(x0, top, w, Math.min(10, h / 2));
    ctx.restore();

    // 1px darker border.
    ctx.save();
    this.roundRectPath(ctx, x0 + 0.5, top + 0.5, w - 1, h - 1, this.CLIP_RADIUS);
    ctx.strokeStyle = '#47566f';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    this.drawClipLabel(ctx, seg.label, x0, top, w, h, '#dfe6f2');
  }

  private drawAudioClip(ctx: CanvasRenderingContext2D, seg: EditorSegment,
                        x0: number, x1: number, row: TrackRow, W: number): void {
    const top = row.top + this.CLIP_INSET_Y;
    const h = row.height - 2 * this.CLIP_INSET_Y;
    const w = x1 - x0;

    ctx.save();
    this.roundRectPath(ctx, x0, top, w, h, this.CLIP_RADIUS);
    ctx.fillStyle = '#3f7a52';
    ctx.fill();
    ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(x0, top, w, Math.min(8, h / 2));

    // Waveform inside the clip, clipped to its rounded rect. Lighter FCP green.
    this.drawWaveInside(ctx, seg, x0, x1, top, h, W);
    ctx.restore();

    ctx.save();
    this.roundRectPath(ctx, x0 + 0.5, top + 0.5, w - 1, h - 1, this.CLIP_RADIUS);
    ctx.strokeStyle = '#2f5e3f';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    this.drawClipLabel(ctx, seg.label, x0, top, w, h, '#d3f0dd');
  }

  private drawClipLabel(ctx: CanvasRenderingContext2D, label: string,
                        x0: number, top: number, w: number, h: number, color: string): void {
    if (w < 22 || !label) return;
    ctx.save();
    this.roundRectPath(ctx, x0, top, w, h, this.CLIP_RADIUS);
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
  private drawWaveInside(ctx: CanvasRenderingContext2D, seg: EditorSegment,
                         x0: number, x1: number, top: number, h: number, W: number): void {
    const mid = top + h / 2;
    const amp = (h / 2) * 0.82;
    const drawX0 = Math.max(0, Math.floor(x0));
    const drawX1 = Math.min(W, Math.ceil(x1));
    const onScreenW = x1 - x0;

    // Too narrow for a visible waveform: plain fill only, and no extraction request.
    if (onScreenW < this.MIN_WAVEFORM_PX) return;

    const peaks = this.getOrRequestPeaks(seg, onScreenW);
    if (!peaks) {
      // Placeholder: a thin center line so the clip doesn't look empty.
      ctx.strokeStyle = '#8fd6a8';
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
    ctx.fillStyle = '#8fd6a8';
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    let started = false;
    for (let x = drawX0; x <= drawX1; x++) {
      const segTime = this.xToTime(x) - seg.timelineStart;
      const frac = segTime / seg.duration;
      if (frac < 0 || frac >= 1) continue;
      const bi = Math.min(n - 1, Math.max(0, Math.floor(frac * n)));
      const yTop = mid - peaks.max[bi] * amp;
      if (!started) { ctx.moveTo(x + 0.5, yTop); started = true; }
      else ctx.lineTo(x + 0.5, yTop);
    }
    for (let x = drawX1; x >= drawX0; x--) {
      const segTime = this.xToTime(x) - seg.timelineStart;
      const frac = segTime / seg.duration;
      if (frac < 0 || frac >= 1) continue;
      const bi = Math.min(n - 1, Math.max(0, Math.floor(frac * n)));
      const yBot = mid - peaks.min[bi] * amp;
      ctx.lineTo(x + 0.5, yBot);
    }
    if (started) { ctx.closePath(); ctx.fill(); }
    ctx.globalAlpha = 1;
  }

  private peaksKey(seg: EditorSegment, buckets: number): string {
    return `${seg.file}|${seg.sourceStart}|${seg.duration}|${buckets}`;
  }

  private getOrRequestPeaks(seg: EditorSegment, onScreenW: number): Peaks | null {
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
      this.peaksInFlight.add(key);
      this.peaksQueue.push(async () => {
        try {
          const res = await this.electron.alignmentExtractPeaks({
            filePath: seg.file, startSec: seg.sourceStart, durationSec: seg.duration, buckets
          });
          if (res?.success && res.min && res.max) {
            this.peaksCache.set(key, { min: res.min, max: res.max });
            this.requestRender();
          } else {
            // Non-fatal (the clip keeps its placeholder line; playback still uses the
            // real file) but never silent — a flat line must not masquerade as silence.
            console.error(`Peak extraction failed for ${seg.file} [${seg.sourceStart}s +${seg.duration}s]:`, res?.error || res);
          }
        } catch (err: any) {
          console.error(`Peak extraction failed for ${seg.file} [${seg.sourceStart}s +${seg.duration}s]:`, err?.message || err);
        } finally {
          this.peaksInFlight.delete(key);
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

  private drawRuler(ctx: CanvasRenderingContext2D, W: number): void {
    ctx.fillStyle = '#2a2a2d';
    ctx.fillRect(0, 0, W, this.RULER_H);
    ctx.strokeStyle = '#000';
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, this.RULER_H + 0.5);
    ctx.lineTo(W, this.RULER_H + 0.5);
    ctx.stroke();
    ctx.globalAlpha = 1;

    const step = this.chooseTickStep();
    const first = Math.ceil(this.scrollOffset / step) * step;
    ctx.strokeStyle = '#4a4a50';
    ctx.fillStyle = '#8a8a90';
    ctx.font = '10px -apple-system, "Segoe UI", sans-serif';
    ctx.textBaseline = 'alphabetic';
    for (let t = first; ; t += step) {
      const x = this.timeToX(t);
      if (x > W) break;
      if (x < 0) continue;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, this.RULER_H - 8);
      ctx.lineTo(x + 0.5, this.RULER_H);
      ctx.stroke();
      ctx.fillText(this.formatRulerLabel(t), x + 4, this.RULER_H - 10);
    }
  }

  /** Pick a "nice" tick interval so labels sit ~80 px apart at the current zoom. */
  private chooseTickStep(): number {
    const targetPx = 80;
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    for (const s of steps) {
      if (s * this.pxPerSec >= targetPx) return s;
    }
    return steps[steps.length - 1];
  }

  private pad2(n: number): string { return n < 10 ? '0' + n : String(n); }

  private formatRulerLabel(t: number): string {
    const total = Math.round(t);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h}:${this.pad2(m)}:${this.pad2(s)}` : `${m}:${this.pad2(s)}`;
  }

  private drawPlayhead(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    const x = this.timeToX(this.playheadTime);
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

  // ── Timecode readout (HH:MM:SS:FF, NDF colons) ──────────────────────────────
  /** Format an EDITED-timeline time (seconds) as HH:MM:SS:FF at the manifest frame rate. */
  private formatTimecode(t: number): string {
    const fs = this.manifest?.frameSeconds || (1001 / 30000);
    const fps = Math.round(1 / fs);
    const totalFrames = Math.round(t / fs);
    const ff = totalFrames % fps;
    const totalSeconds = Math.floor(totalFrames / fps);
    const ss = totalSeconds % 60;
    const mm = Math.floor(totalSeconds / 60) % 60;
    const hh = Math.floor(totalSeconds / 3600);
    return `${this.pad2(hh)}:${this.pad2(mm)}:${this.pad2(ss)}:${this.pad2(ff)}`;
  }

  get timecode(): string { return this.formatTimecode(this.playheadTime); }

  get sessionName(): string { return this.manifest?.session || ''; }

  // ── File URL (copied technique from alignment.component.ts) ──────────────────
  private pathToFileUrl(p: string): string {
    return 'file://' + p.split('/').map(encodeURIComponent).join('/');
  }

  // ── Scrub / drag on canvas ──────────────────────────────────────────────────
  onCanvasMouseDown(ev: MouseEvent): void {
    if (this.errorMessage || !this.manifest) return;
    ev.preventDefault();
    this.menuOpen = false;                 // a canvas interaction dismisses the File menu
    const t = this.canvasEventTime(ev);
    const y = this.canvasEventY(ev);
    const inRuler = y <= this.RULER_H;

    if (ev.shiftKey) {
      // Shift+drag paints a single free range (edited seconds) instead of scrubbing — a manual
      // range that replaces any marquee selection, so a group highlight no longer applies.
      this.selectedRanges = [];
      this.selStart = t;
      this.selEnd = t;
      this.selectedGroupStart = null;
      this.selectedGroupEnd = null;
      this.draggingSelection = true;
      window.addEventListener('mousemove', this.onWindowMouseMove);
      window.addEventListener('mouseup', this.onWindowMouseUp);
      this.requestRender();
      return;
    }

    // Blade tool: a track-area click also drops a boundary at the click time (ORIGINAL
    // seconds) before scrubbing/selecting. Ruler clicks stay pure scrubs in either tool.
    if (this.toolMode === 'blade' && !inRuler) {
      this.addBladeBoundary(this.editedToOriginal(t));
    }

    // A drag on the RULER always scrubs the playhead (either tool) — never a marquee.
    if (inRuler) {
      this.draggingPlayhead = true;
      this.setPlayhead(t);
      window.addEventListener('mousemove', this.onWindowMouseMove);
      window.addEventListener('mouseup', this.onWindowMouseUp);
      this.requestRender();
      return;
    }

    const onClip = !!(this.rowAt(y) && this.segmentAt(this.rowAt(y)!.track.id, t));

    if (this.toolMode === 'select') {
      // SELECT tool, track lane: a plain CLICK scrubs + selects the clicked section (or clears
      // in a gap); a DRAG turns into a marquee (committed on release). Set the click outcome
      // now; commitMarquee overrides it iff the pointer actually moves.
      this.setPlayhead(t);
      this.selectedRanges = [];
      if (onClip) {
        this.selectSectionAround(t);
      } else {
        this.selStart = null;
        this.selEnd = null;
        this.selectedGroupStart = null;
        this.selectedGroupEnd = null;
      }
      this.marqueeActive = true;
      this.marqueeMoved = false;
      this.marqueeStartTime = t;
      this.marqueeEndTime = t;
      window.addEventListener('mousemove', this.onWindowMouseMove);
      window.addEventListener('mouseup', this.onWindowMouseUp);
      this.requestRender();
      return;
    }

    // BLADE tool, track lane: keep the original scrub + section-select drag behavior.
    this.draggingPlayhead = true;
    this.setPlayhead(t);
    this.selectedRanges = [];
    if (onClip) {
      this.selectSectionAround(t);
    } else {
      this.selStart = null;
      this.selEnd = null;
      this.selectedGroupStart = null;
      this.selectedGroupEnd = null;
    }
    window.addEventListener('mousemove', this.onWindowMouseMove);
    window.addEventListener('mouseup', this.onWindowMouseUp);
    this.requestRender();
  }

  /** CSS-px Y of a mouse event within the canvas (canvas-local, top = 0). */
  private canvasEventY(ev: MouseEvent): number {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    return ev.clientY - rect.top - (canvas.clientTop || 0);
  }

  /** The track row under a canvas-local Y (offset-aware via trackRows), or null. */
  private rowAt(cssY: number): TrackRow | null {
    for (const row of this.trackRows) {
      if (cssY >= row.top && cssY < row.top + row.height) return row;
    }
    return null;
  }

  /**
   * Select the section around edited time `t`. The boundary set is the PRIMARY video
   * track's clip edges ∪ the blade boundaries (mapped to edited seconds) ∪ the timeline
   * ends. The two boundaries bracketing `t` become the selection; a degenerate bracket
   * clears it. Blades carve a clip into sub-sections; with none, the section is the clip.
   */
  private selectSectionAround(t: number): void {
    const bounds = this.sectionBoundaries();
    let lo: number | null = null, hi: number | null = null;
    for (const b of bounds) {
      if (b <= t + this.EPS) { if (lo === null || b > lo) lo = b; }
      if (b > t + this.EPS) { if (hi === null || b < hi) hi = b; }
    }
    if (lo === null || hi === null || hi - lo <= this.EPS) {
      this.selStart = null;
      this.selEnd = null;
    } else {
      this.selStart = lo;
      this.selEnd = hi;
    }
    // A section click is not a transcript-group selection.
    this.selectedGroupStart = null;
    this.selectedGroupEnd = null;
  }

  /** Sorted, de-duplicated section boundaries in EDITED seconds. */
  private sectionBoundaries(): number[] {
    const out: number[] = [0, this.editedDuration];
    const primary = this.primaryVideoTrackId;
    if (primary) {
      for (const seg of this.segsByTrack.get(primary) || []) {
        out.push(seg.timelineStart, seg.timelineStart + seg.duration);
      }
    }
    for (const b of this.bladeBoundaries) {
      const e = this.originalToEdited(b);
      if (e > this.EPS && e < this.editedDuration - this.EPS) out.push(e);
    }
    out.sort((a, b) => a - b);
    const dedup: number[] = [];
    for (const v of out) {
      if (dedup.length === 0 || v - dedup[dedup.length - 1] > this.EPS) dedup.push(v);
    }
    return dedup;
  }

  /** Add a blade boundary (ORIGINAL seconds), sorted + de-duplicated. */
  private addBladeBoundary(originalSec: number): void {
    const t = Math.min(this.manifest?.timelineDuration || 0, Math.max(0, originalSec));
    for (const b of this.bladeBoundaries) {
      if (Math.abs(b - t) <= this.EPS) return; // already present
    }
    this.bladeBoundaries.push(t);
    this.bladeBoundaries.sort((a, b) => a - b);
  }

  /** Drop blade boundaries that a cut has swallowed (their original time now inside a cut). */
  private pruneBladeBoundaries(): void {
    if (this.bladeBoundaries.length === 0) return;
    const fs = this.manifest?.frameSeconds;
    if (!fs) return;
    this.bladeBoundaries = this.bladeBoundaries.filter(b => {
      for (const c of this.cuts) {
        if (b > c.startFrame * fs + this.EPS && b < c.endFrame * fs - this.EPS) return false;
      }
      return true;
    });
  }

  /** Switch the active pointer tool (Arrow / Blade). */
  setTool(mode: ToolMode): void {
    this.toolMode = mode;
  }

  private onWindowMouseMove = (ev: MouseEvent): void => {
    if (this.draggingSelection) { this.selEnd = this.canvasEventTime(ev); this.requestRender(); }
    else if (this.marqueeActive) {
      this.marqueeEndTime = this.canvasEventTime(ev);
      // Promote to a real marquee only past a small pixel threshold, so a jittery click stays
      // a click (section select) instead of collapsing the selection to a hairline range.
      if (Math.abs(this.timeToX(this.marqueeEndTime) - this.timeToX(this.marqueeStartTime)) > 3) {
        this.marqueeMoved = true;
      }
      this.requestRender();
    }
    else if (this.draggingPlayhead) this.setPlayheadFromEvent(ev);
    else if (this.draggingScrollbar) this.setScrollFromScrollbar(ev);
    else if (this.draggingSplitV) this.setSplitVFromEvent(ev);
    else if (this.draggingSplitH) this.setSplitHFromEvent(ev);
    else if (this.draggingSplitP) this.setSplitPFromEvent(ev);
  };

  private onWindowMouseUp = (): void => {
    if (!this.draggingPlayhead && !this.draggingScrollbar && !this.draggingSplitV
        && !this.draggingSplitH && !this.draggingSplitP && !this.draggingSelection
        && !this.marqueeActive) return;
    // Persist split preferences once per drag (not per move frame).
    if (this.draggingSplitV) localStorage.setItem(this.SPLIT_V_KEY, String(this.splitV));
    if (this.draggingSplitH) localStorage.setItem(this.SPLIT_H_KEY, String(this.splitH));
    if (this.draggingSplitP) localStorage.setItem(this.SPLIT_P_KEY, String(Math.round(this.projectWidth)));
    // A marquee that actually moved commits its section selection; a bare click leaves the
    // section-select outcome from mousedown untouched.
    if (this.marqueeActive) {
      if (this.marqueeMoved) this.commitMarquee();
      this.marqueeActive = false;
      this.marqueeMoved = false;
    }
    this.draggingPlayhead = false;
    this.draggingScrollbar = false;
    this.draggingSplitV = false;
    this.draggingSplitH = false;
    this.draggingSplitP = false;
    this.draggingSelection = false;
    document.body.style.userSelect = '';
    window.removeEventListener('mousemove', this.onWindowMouseMove);
    window.removeEventListener('mouseup', this.onWindowMouseUp);
    this.requestRender();
  };

  // ── Pane splitters (vertical: transcript|viewer, horizontal: top|timeline) ──
  /** Read a persisted split ratio; corrupt values fall back, valid ones are clamped. */
  private readSplit(key: string, min: number, max: number, fallback: number): number {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const v = parseFloat(raw);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, v));
  }

  onSplitVMouseDown(ev: MouseEvent): void {
    ev.preventDefault();
    this.draggingSplitV = true;
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', this.onWindowMouseMove);
    window.addEventListener('mouseup', this.onWindowMouseUp);
  }

  onSplitHMouseDown(ev: MouseEvent): void {
    ev.preventDefault();
    this.draggingSplitH = true;
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', this.onWindowMouseMove);
    window.addEventListener('mouseup', this.onWindowMouseUp);
  }

  onSplitPMouseDown(ev: MouseEvent): void {
    ev.preventDefault();
    this.draggingSplitP = true;
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', this.onWindowMouseMove);
    window.addEventListener('mouseup', this.onWindowMouseUp);
  }

  private setSplitPFromEvent(ev: MouseEvent): void {
    const el = this.topRegionRef?.nativeElement;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    this.projectWidth = Math.min(this.SPLIT_P_MAX, Math.max(this.SPLIT_P_MIN, px));
    // Same live-resize path as the other splitters (viewer/canvas re-layout + redraw).
    this.onResize();
  }

  private setSplitVFromEvent(ev: MouseEvent): void {
    const el = this.topRegionRef?.nativeElement;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    // splitV is the transcript's flex-basis as a fraction of the WHOLE top region, but the
    // transcript now starts after the fixed project column (+ its splitter), so subtract
    // that lead-in to keep the V splitter under the cursor.
    const lead = this.projectWidth + this.SPLITTER_PX;
    const frac = (ev.clientX - rect.left - lead) / rect.width;
    this.splitV = Math.min(this.SPLIT_V_MAX, Math.max(this.SPLIT_V_MIN, frac));
    // Same path as the window-resize handler so any layout knock-on re-renders live.
    this.onResize();
  }

  private setSplitHFromEvent(ev: MouseEvent): void {
    const h = window.innerHeight;
    if (h <= 0) return;
    // Timeline share = distance from the cursor to the window bottom.
    const frac = (h - ev.clientY) / h;
    this.splitH = Math.min(this.SPLIT_H_MAX, Math.max(this.SPLIT_H_MIN, frac));
    // The canvas height (and, via flex, potentially width) changes under the cursor:
    // clampScroll + requestRender every drag frame so the redraw tracks the drag live.
    this.onResize();
  }

  /** Edited-seconds time under a canvas mouse event, clamped to [0, editedDuration]. */
  private canvasEventTime(ev: MouseEvent): number {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    const cssX = ev.clientX - rect.left - (canvas.clientLeft || 0);
    const t = this.xToTime(Math.max(0, cssX));
    return Math.min(this.editedDuration, Math.max(0, t));
  }

  private setPlayheadFromEvent(ev: MouseEvent): void {
    this.setPlayhead(this.canvasEventTime(ev));
  }

  private setPlayhead(t: number): void {
    const dur = this.editedDuration;
    this.playheadTime = Math.min(dur, Math.max(0, t));
    if (this.isPlaying) {
      // Re-anchor the clock so playback continues from the new position.
      this.playAnchorPerfMs = performance.now();
      this.playAnchorTime = this.playheadTime;
    } else {
      this.seekViewerToPlayhead();
    }
    this.requestRender();
  }

  // ── Scrollbar ───────────────────────────────────────────────────────────────
  get scrollbarThumb(): { left: number; width: number } {
    const dur = this.editedDuration || 1;
    const width = Math.max(6, Math.min(100, (this.viewportSec / dur) * 100));
    const maxScroll = Math.max(1e-6, dur - this.viewportSec);
    const left = maxScroll <= 0 ? 0 : (this.scrollOffset / maxScroll) * (100 - width);
    return { left, width };
  }

  onScrollbarThumbMouseDown(ev: MouseEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.draggingScrollbar = true;
    const track = (ev.currentTarget as HTMLElement).parentElement!;
    const rect = track.getBoundingClientRect();
    const thumb = this.scrollbarThumb;
    const thumbLeftPx = (thumb.left / 100) * rect.width;
    this.scrollbarGrabDx = (ev.clientX - rect.left) - thumbLeftPx;
    window.addEventListener('mousemove', this.onWindowMouseMove);
    window.addEventListener('mouseup', this.onWindowMouseUp);
  }

  private setScrollFromScrollbar(ev: MouseEvent): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dur = this.editedDuration;
    const thumb = this.scrollbarThumb;
    const trackW = rect.width;
    const thumbWpx = (thumb.width / 100) * trackW;
    const leftPx = (ev.clientX - rect.left) - this.scrollbarGrabDx;
    const frac = trackW - thumbWpx <= 0 ? 0 : Math.min(1, Math.max(0, leftPx / (trackW - thumbWpx)));
    this.scrollOffset = this.clampScroll(frac * Math.max(0, dur - this.viewportSec));
    this.requestRender();
  }

  // ── Zoom ────────────────────────────────────────────────────────────────────
  onZoomSlider(value: number): void {
    // Slider zooms about the playhead (keeps it fixed on screen).
    const anchorX = this.timeToX(this.playheadTime);
    this.setZoom(Number(value), this.playheadTime, anchorX);
  }

  private setZoom(newPps: number, anchorTime: number, anchorCssX: number): void {
    this.pxPerSec = this.clampZoom(newPps);
    // Keep anchorTime under anchorCssX: scrollOffset = anchorTime - anchorCssX/pxPerSec.
    this.scrollOffset = this.clampScroll(anchorTime - anchorCssX / this.pxPerSec);
    this.requestRender();
  }

  // ── Wheel: pan / pinch-zoom ─────────────────────────────────────────────────
  onWheel(ev: WheelEvent): void {
    if (this.errorMessage || !this.manifest) return;
    ev.preventDefault();
    if (ev.ctrlKey || ev.metaKey) {
      // Pinch / ctrl-wheel → zoom about the cursor.
      const canvas = this.canvasRef?.nativeElement;
      const rect = canvas!.getBoundingClientRect();
      const cssX = ev.clientX - rect.left;
      const cursorTime = this.xToTime(cssX);
      const factor = Math.exp(-ev.deltaY * 0.0015);
      this.setZoom(this.pxPerSec * factor, cursorTime, cssX);
    } else {
      // Horizontal wheel (or shift+wheel) pans.
      const delta = ev.shiftKey ? ev.deltaY : (ev.deltaX || 0);
      this.scrollOffset = this.clampScroll(this.scrollOffset + delta / this.pxPerSec);
      this.requestRender();
    }
  }

  @HostListener('window:resize')
  onResize(): void {
    this.scrollOffset = this.clampScroll(this.scrollOffset);
    this.requestRender();
  }

  // ── Keyboard ────────────────────────────────────────────────────────────────
  @HostListener('window:keydown', ['$event'])
  onKeyDown(ev: KeyboardEvent): void {
    if (this.errorMessage || !this.manifest) return;
    // Escape first dismisses an open File menu or export modal — even from a focused field —
    // so it never falls through to a selection clear underneath.
    if (ev.key === 'Escape' && (this.menuOpen || this.exportResultPath || this.exportError)) {
      ev.preventDefault();
      this.menuOpen = false;
      this.closeExportModal();
      return;
    }
    // Ignore every editor shortcut while the user is typing (e.g. the transcript search
    // box) — space, A/B, I/O, Delete, Cmd+X, Cmd+E must reach the input, not the timeline.
    if (this.isTypingTarget(ev.target)) return;
    if (ev.key === ' ' || ev.code === 'Space') {
      ev.preventDefault();
      this.togglePlayback();
    } else if (ev.key === 'Home') {
      ev.preventDefault();
      this.setPlayhead(0);
    } else if (ev.key === 'End') {
      ev.preventDefault();
      this.setPlayhead(this.editedDuration);
    } else if ((ev.metaKey || ev.ctrlKey) && (ev.key === '=' || ev.key === '+')) {
      ev.preventDefault();
      const anchorX = this.timeToX(this.playheadTime);
      this.setZoom(this.pxPerSec * 1.25, this.playheadTime, anchorX);
    } else if ((ev.metaKey || ev.ctrlKey) && ev.key === '-') {
      ev.preventDefault();
      const anchorX = this.timeToX(this.playheadTime);
      this.setZoom(this.pxPerSec / 1.25, this.playheadTime, anchorX);
    } else if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'z' || ev.key === 'Z')) {
      // Undo / redo the cut list (Shift adds redo). Guarded off while loading.
      if (this.loading) return;
      ev.preventDefault();
      if (ev.shiftKey) this.redo(); else this.undo();
    } else if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'e' || ev.key === 'E')) {
      // Cmd/Ctrl+E exports (no-op while loading or with zero cuts — onExport guards both).
      ev.preventDefault();
      if (this.loading) return;
      void this.onExport();
    } else if (ev.key === 'i' || ev.key === 'I') {
      if (this.loading) return;
      ev.preventDefault();
      this.selectedRanges = [];            // a fresh in-mark replaces any marquee selection
      this.selStart = this.playheadTime;   // FCP in-mark at the playhead
      this.selectedGroupStart = null;
      this.selectedGroupEnd = null;
      this.requestRender();
    } else if (ev.key === 'o' || ev.key === 'O') {
      if (this.loading) return;
      ev.preventDefault();
      this.selectedRanges = [];            // a fresh out-mark replaces any marquee selection
      this.selEnd = this.playheadTime;     // FCP out-mark at the playhead
      this.selectedGroupStart = null;
      this.selectedGroupEnd = null;
      this.requestRender();
    } else if (ev.key === 'a' || ev.key === 'A') {
      ev.preventDefault();
      this.setTool('select');              // FCP Arrow tool
    } else if (ev.key === 'b' || ev.key === 'B') {
      ev.preventDefault();
      this.setTool('blade');               // FCP Blade tool
    } else if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'x' || ev.key === 'X')) {
      // Cmd/Ctrl+X == ripple-delete the current selection (FCP alias for Delete).
      if (this.loading) return;
      ev.preventDefault();
      this.deleteSelection();
    } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
      if (this.loading) return;
      ev.preventDefault();
      this.deleteSelection();
    } else if (ev.key === 'Escape') {
      if (this.loading) return;
      // Clear the timeline selection (single + marquee) and the transcript-group highlight.
      this.clearSelection();
      this.requestRender();
    }
  }

  /** True when a keydown target is an editable field (input / textarea / contentEditable). */
  private isTypingTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
  }

  // ── Selection + cut editing ─────────────────────────────────────────────────
  /** Normalized selection [lo, hi] in EDITED seconds, or null when absent/one-sided/empty. */
  private selRange(): { lo: number; hi: number } | null {
    if (this.selStart == null || this.selEnd == null) return null;
    const lo = Math.min(this.selStart, this.selEnd);
    const hi = Math.max(this.selStart, this.selEnd);
    if (hi - lo <= this.EPS) return null;
    return { lo, hi };
  }

  /** Merge a cut list into sorted, non-overlapping order (adjacent frame ranges coalesce). */
  private mergeCuts(list: Cut[]): Cut[] {
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

  private pushUndo(): void {
    this.undoStack.push(this.cuts);
    if (this.undoStack.length > this.UNDO_LIMIT) this.undoStack.shift();
  }

  /**
   * Ripple-delete the current selection: map its edited edges back to original seconds,
   * quantize to frames (the ONE place frame quantization happens), merge into `cuts`, rebuild
   * the edited model, and land the playhead on the seam. A selection that rounds to zero
   * frames is rejected (just clears) and leaves the undo stack untouched.
   */
  private deleteSelection(): void {
    const ranges = this.allSelectionRanges();
    if (ranges.length === 0 || !this.manifest) return;
    const fs = this.manifest.frameSeconds;
    // Map every selected range back to ORIGINAL frames FIRST (all against the current edited
    // model), then merge them into `cuts` in one shot. A single ripple removes them all.
    const newCuts: Cut[] = [];
    let firstStartFrame: number | null = null;
    for (const r of ranges) {
      const startFrame = Math.round(this.editedToOriginal(r.lo) / fs);
      const endFrame = Math.round(this.editedToOriginal(r.hi) / fs);
      if (endFrame <= startFrame) continue;   // sub-frame range — nothing to remove
      newCuts.push({ startFrame, endFrame });
      if (firstStartFrame === null || startFrame < firstStartFrame) firstStartFrame = startFrame;
    }
    if (newCuts.length === 0) {
      // Every range rounded to zero frames. Clear and bail without touching history.
      this.clearSelection();
      this.requestRender();
      return;
    }
    this.pushUndo();
    this.redoStack = [];
    this.cuts = this.mergeCuts([...this.cuts, ...newCuts]);
    this.rebuildEditedModel();
    this.pruneBladeBoundaries();   // drop any boundary the new cuts swallowed
    this.clearSelection();
    // Seam = where the earliest removed span used to begin, in the NEW edited timeline.
    const seam = this.originalToEdited(firstStartFrame! * fs);
    this.landPlayheadAfterEdit(seam, true);
  }

  private undo(): void {
    if (this.undoStack.length === 0) return;
    const origTime = this.editedToOriginal(this.playheadTime);
    this.redoStack.push(this.cuts);
    this.cuts = this.undoStack.pop()!;
    this.rebuildEditedModel();
    this.clearSelection();
    this.landPlayheadAfterEdit(this.originalToEdited(origTime), false);
  }

  private redo(): void {
    if (this.redoStack.length === 0) return;
    const origTime = this.editedToOriginal(this.playheadTime);
    this.pushUndo();
    this.cuts = this.redoStack.pop()!;
    this.rebuildEditedModel();
    this.clearSelection();
    this.landPlayheadAfterEdit(this.originalToEdited(origTime), false);
  }

  /**
   * After a model rebuild, place the playhead at `t` (edited seconds), reclamp scroll, and
   * resync media. `stopIfPlaying` stops playback (ripple delete jumps the timeline under the
   * clock); undo/redo instead re-anchor and keep playing.
   */
  private landPlayheadAfterEdit(t: number, stopIfPlaying: boolean): void {
    this.playheadTime = Math.min(this.editedDuration, Math.max(0, t));
    this.scrollOffset = this.clampScroll(this.scrollOffset);
    if (this.isPlaying) {
      if (stopIfPlaying) {
        this.stopPlayback();
        this.seekViewerToPlayhead();
      } else {
        // Re-anchor the clock so playback continues from the mapped position.
        this.playAnchorPerfMs = performance.now();
        this.playAnchorTime = this.playheadTime;
      }
    } else {
      this.seekViewerToPlayhead();
    }
    this.requestRender();
    this.cdr.detectChanges();
  }

  // ── Export ──────────────────────────────────────────────────────────────────
  /** Total removed time (seconds) across all cuts. */
  get removedSeconds(): number {
    const fs = this.manifest?.frameSeconds || (1001 / 30000);
    let frames = 0;
    for (const c of this.cuts) frames += (c.endFrame - c.startFrame);
    return frames * fs;
  }

  /** "M:SS" removed-time label for the top-bar edit indicator. */
  get removedLabel(): string {
    const sec = Math.round(this.removedSeconds);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${this.pad2(s)}`;
  }

  /** Export the current cut list to a revised master-hybrid FCPXML via Python. */
  async onExport(): Promise<void> {
    if (this.exporting || this.cuts.length === 0 || !this.currentZipPath) return;
    this.exporting = true;
    this.exportError = null;
    this.exportResultPath = null;
    this.cdr.detectChanges();
    try {
      const res = await this.electron.exportEditorCuts({ zipPath: this.currentZipPath, cuts: this.cuts });
      const path = res?.path;
      if (!path) throw new Error(res?.message || 'Export did not return an output path.');
      this.exportResultPath = path;
    } catch (err: any) {
      // Python's message is authoritative — show it verbatim.
      this.exportError = err?.message || String(err);
    } finally {
      this.exporting = false;
      this.menuOpen = false;   // the result now shows in the modal, not the menu
      this.cdr.detectChanges();
    }
  }

  /** Reveal the exported file in Finder/Explorer. */
  onShowExport(): void {
    if (this.exportResultPath) void this.electron.showInFolder(this.exportResultPath);
  }

  /** Dismiss the export result/error modal. */
  closeExportModal(): void {
    this.exportResultPath = null;
    this.exportError = null;
  }

  // ── Top-bar File menu ────────────────────────────────────────────────────────
  /** Toggle the File menu dropdown. */
  toggleMenu(): void { this.menuOpen = !this.menuOpen; }

  /** File ▸ Export FCPXML: run the export (kept open so its busy state shows; onExport closes it). */
  onExportFromMenu(): void {
    if (this.cuts.length === 0 || this.exporting) return;
    void this.onExport();
  }

  /** File ▸ Open…: close the menu and run the existing project picker. */
  onOpenFromMenu(): void {
    this.menuOpen = false;
    void this.pickProject();
  }

  /**
   * Friendly DISPLAY name for a track/speaker id: strip a trailing '_voiceiso_processed',
   * '_processed', or '_voiceiso' (longest first), turn remaining underscores into spaces,
   * collapse whitespace, trim, and capitalize the first character. Pure — never mutates the
   * underlying track ids used for logic. 'mic audio_voiceiso_processed' → 'Mic audio';
   * 'screen audio_processed' → 'Screen audio'; 'merged'/'Merged' → 'Merged'.
   */
  prettyLabel(raw: string): string {
    if (!raw) return raw;
    let s = raw;
    for (const suf of ['_voiceiso_processed', '_processed', '_voiceiso']) {
      if (s.toLowerCase().endsWith(suf)) { s = s.slice(0, s.length - suf.length); break; }
    }
    s = s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    if (s.length === 0) return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // ── Project picker (recents shared with the launcher) ───────────────────────
  /** Read the shared recents blob; corrupt/foreign entries are dropped (never crash). */
  private readRecents(): RecentSession[] {
    try {
      const raw = localStorage.getItem(this.RECENTS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((r: any) => r && typeof r.zipPath === 'string');
    } catch {
      return [];
    }
  }

  private writeRecents(list: RecentSession[]): void {
    localStorage.setItem(this.RECENTS_KEY, JSON.stringify(list));
  }

  /** Filename minus the _compounds.zip suffix (mirrors the launcher's deriveName). */
  private deriveName(zipPath: string): string {
    const base = zipPath.split(/[\\/]/).pop() || zipPath;
    if (base.endsWith(this.COMPOUNDS_SUFFIX)) return base.slice(0, -this.COMPOUNDS_SUFFIX.length);
    return base.replace(/\.zip$/i, '');
  }

  /**
   * Load recents and drop any whose zip has vanished (same prune the launcher does). If the
   * store is empty but a session is already loaded, seed the list with it so the picker
   * always shows at least the current session (highlighted).
   */
  private async loadAndPruneRecents(): Promise<void> {
    const stored = this.readRecents();
    const kept: RecentSession[] = [];
    for (const r of stored) {
      try {
        const res = await this.electron.checkFileExists(r.zipPath);
        if (res?.exists) kept.push(r);
      } catch {
        // Cannot verify (not in Electron / IPC hiccup): keep rather than silently delete.
        kept.push(r);
      }
    }
    kept.sort((a, b) => (b.lastOpened || '').localeCompare(a.lastOpened || ''));
    if (kept.length === 0 && this.currentZipPath) {
      kept.push({ zipPath: this.currentZipPath, name: this.deriveName(this.currentZipPath), lastOpened: new Date().toISOString() });
    }
    this.recents = kept;
    this.writeRecents(kept);
    this.cdr.detectChanges();
  }

  /**
   * Move (or add) a session to the front with a fresh lastOpened; persist + re-sort. Rebased
   * on the freshly-read store (not in-memory this.recents, which may not have finished its
   * async prune yet) so a bootstrap can never clobber the launcher's other recents.
   */
  private recordRecent(zipPath: string): void {
    const entry: RecentSession = { zipPath, name: this.deriveName(zipPath), lastOpened: new Date().toISOString() };
    const rest = this.readRecents().filter(r => r.zipPath !== zipPath);
    this.recents = [entry, ...rest];
    this.writeRecents(this.recents);
  }

  /** The row for the session currently loaded in THIS window (for the active highlight). */
  isCurrentSession(r: RecentSession): boolean {
    return r.zipPath === this.currentZipPath;
  }

  /** Click a recents row → load it INTO THIS WINDOW via the existing bootstrap (no new window). */
  openProject(r: RecentSession): void {
    if (r.zipPath === this.currentZipPath) return; // already loaded here
    void this.bootstrap(r.zipPath);
  }

  /** "+ Open…" → pick a _compounds.zip and bootstrap it into this window. */
  async pickProject(): Promise<void> {
    let picked: { canceled: boolean; filePaths: string[] };
    try {
      picked = await this.electron.selectFile({
        title: 'Choose a session’s _compounds.zip',
        filters: [{ name: 'Compound Session', extensions: ['zip'] }]
      });
    } catch {
      return; // dialog failure is non-fatal to the open session; user can retry
    }
    if (picked.canceled || !picked.filePaths?.length) return;
    void this.bootstrap(picked.filePaths[0]);
  }

  // ── Transcript ──────────────────────────────────────────────────────────────
  /**
   * Load the session's transcript sidecar (if any) and render state 1 (none) or 3 (ready).
   * Generation-guarded like the manifest load: a slow read for a superseded session is
   * dropped. A parse/shape failure surfaces verbatim in the pane (state error), never a
   * silent empty transcript.
   */
  private async loadTranscriptForSession(zipPath: string, generation: number): Promise<void> {
    let data: any;
    try {
      data = await this.electron.loadTranscript({ zipPath });
    } catch (err: any) {
      if (generation !== this.bootstrapGeneration) return;
      this.transcriptState = 'error';
      this.transcriptError = err?.message || String(err);
      this.cdr.detectChanges();
      return;
    }
    if (generation !== this.bootstrapGeneration) return; // superseded by a newer session
    if (!data) { this.transcriptState = 'none'; this.cdr.detectChanges(); return; }
    try {
      this.ingestTranscript(data as Transcript);
    } catch (err: any) {
      this.transcriptState = 'error';
      this.transcriptError = err?.message || String(err);
    }
    this.cdr.detectChanges();
  }

  /** Validate + index a transcript into render groups. Fails loud on a malformed shape. */
  private ingestTranscript(t: Transcript): void {
    if (!t || typeof t !== 'object') throw new Error('Transcript sidecar was empty or malformed.');
    if (!Array.isArray(t.tracks)) throw new Error('Transcript sidecar has no tracks array.');
    if (!Array.isArray(t.words)) throw new Error('Transcript sidecar has no words array.');

    // Stable color per track id, by discovery order (t0, t1, … in the tracks array).
    const colorByTrack = new Map<string, string>();
    const labelByTrack = new Map<string, string>();
    t.tracks.forEach((tr, i) => {
      colorByTrack.set(tr.id, this.TRACK_COLORS[i % this.TRACK_COLORS.length]);
      labelByTrack.set(tr.id, tr.label);
    });

    // Bucket words by (track, group) — one bucket per timeline clip's worth of speech.
    const buckets = new Map<string, TranscriptWord[]>();
    for (const w of t.words) {
      const key = `${w.track}|${w.group}`;
      let arr = buckets.get(key);
      if (!arr) { arr = []; buckets.set(key, arr); }
      arr.push(w);
    }

    const groups: TranscriptGroup[] = [];
    for (const arr of buckets.values()) {
      const trackId = arr[0].track;
      // Words are already sorted by (track, fileStart); join in that order.
      const text = arr.map(w => w.text).join(' ').replace(/\s+/g, ' ').trim();
      let os = Infinity, oe = -Infinity;
      for (const w of arr) {
        if (w.timelineStart < os) os = w.timelineStart;
        if (w.timelineEnd > oe) oe = w.timelineEnd;
      }
      groups.push({
        trackId,
        label: labelByTrack.get(trackId) ?? trackId,
        color: colorByTrack.get(trackId) ?? '#8a8a90',
        text,
        originalStart: os,
        originalEnd: oe,
      });
    }
    // Timeline order; ties (concurrent speech on two tracks) broken by track id for stability.
    groups.sort((a, b) => (a.originalStart - b.originalStart) || a.trackId.localeCompare(b.trackId));

    this.transcript = t;
    this.transcriptGroups = groups;
    this.transcriptTracks = t.tracks.map(tr => ({ id: tr.id, label: tr.label }));
    // Default source = the FIRST track (the mic): the user primarily wants to read their
    // own words, not the merged interleave.
    this.sourceFilter = t.tracks.length > 0 ? t.tracks[0].id : 'merged';
    this.searchQuery = '';
    this.transcriptWordCount = t.words.length;
    this.transcriptState = 'ready';
    this.recomputeVisibleGroups();
  }

  /**
   * Project transcriptGroups → visibleGroups: drop groups whose whole original range was cut,
   * and stamp each survivor with its current edited-timeline timecode. Pure recompute (no
   * caching): called on load and on every cut-model rebuild.
   */
  private recomputeVisibleGroups(): void {
    if (this.transcriptGroups.length === 0) { this.visibleGroups = []; return; }
    // Source filter: a single track id shows only that track's groups; 'merged' shows all
    // tracks interleaved (transcriptGroups is already in timeline order). Then the free-text
    // search (case-insensitive substring). Then the existing "fully inside a cut" drop.
    const merged = this.sourceFilter === 'merged';
    const q = this.searchQuery.trim().toLowerCase();
    const out: TranscriptGroupView[] = [];
    for (const g of this.transcriptGroups) {
      if (!merged && g.trackId !== this.sourceFilter) continue;
      if (q && !g.text.toLowerCase().includes(q)) continue;
      if (this.isGroupFullyCut(g)) continue;
      const editedStart = this.originalToEdited(g.originalStart);
      out.push({
        label: g.label,
        color: g.color,
        text: g.text,
        originalStart: g.originalStart,
        originalEnd: g.originalEnd,
        timecode: this.formatTimecode(editedStart),
      });
    }
    this.visibleGroups = out;
  }

  /** Filter-chip select: switch the shown source track (or 'merged') and recompute. */
  setSourceFilter(id: string): void {
    if (this.sourceFilter === id) return;
    this.sourceFilter = id;
    this.recomputeVisibleGroups();
  }

  /** Live search input: recompute the visible groups against the query. */
  onSearchInput(value: string): void {
    this.searchQuery = value;
    this.recomputeVisibleGroups();
  }

  /** Clear the search box (× button). */
  clearSearch(): void {
    if (this.searchQuery === '') return;
    this.searchQuery = '';
    this.recomputeVisibleGroups();
  }

  /**
   * A group is fully cut when its entire original range lies inside a single cut interval
   * (cuts are merged + non-overlapping, so a wholly-removed span can only fall in one). Checked
   * directly against `cuts` in frames × frameSeconds — the same seconds base the group uses.
   */
  private isGroupFullyCut(g: TranscriptGroup): boolean {
    const fs = this.manifest?.frameSeconds;
    if (!fs) return false;
    for (const c of this.cuts) {
      const cs = c.startFrame * fs;
      const ce = c.endFrame * fs;
      if (g.originalStart >= cs - this.EPS && g.originalEnd <= ce + this.EPS) return true;
    }
    return false;
  }

  /** Start (or restart) the transcription job for the current session. */
  async startTranscription(): Promise<void> {
    if (!this.currentZipPath) return;
    this.transcriptState = 'running';
    this.transcribeProgress = 0;
    this.transcribeMessage = 'Starting…';
    this.transcribeEtaSeconds = null;
    this.transcriptError = '';
    this.transcribeJobId = null;
    this.cdr.detectChanges();
    try {
      const res = await this.electron.transcribeSession({ zipPath: this.currentZipPath });
      const jobId = res?.jobId;
      if (!jobId) throw new Error('Transcription did not start (no job id returned).');
      this.transcribeJobId = jobId;
    } catch (err: any) {
      this.transcriptState = 'error';
      this.transcriptError = err?.message || String(err);
      this.cdr.detectChanges();
    }
  }

  /** Ask the main process to cancel the running job; the failure lands via the complete event. */
  cancelTranscription(): void {
    if (this.transcribeJobId) void this.electron.cancelTranscription({ jobId: this.transcribeJobId });
  }

  /** Progress event: ignore anything not from the current job (stale/superseded session). */
  private onTranscribeProgress(d: { jobId: string; progress: number; message: string; etaSeconds?: number | null }): void {
    if (!d || d.jobId !== this.transcribeJobId) return;
    if (this.transcriptState !== 'running') return;
    this.transcribeProgress = Math.max(0, Math.min(100, Math.round(d.progress)));
    this.transcribeMessage = d.message || '';
    this.transcribeEtaSeconds = (typeof d.etaSeconds === 'number' && d.etaSeconds >= 0) ? d.etaSeconds : null;
    this.cdr.detectChanges();
  }

  /** Human "about N min / N sec left" from the measured ETA, or "estimating…" before it's known. */
  get transcribeEtaLabel(): string {
    const s = this.transcribeEtaSeconds;
    if (s === null) return 'estimating time remaining…';
    if (s <= 0) return 'finishing up…';
    if (s < 60) return `about ${s} sec left`;
    const m = Math.round(s / 60);
    return `about ${m} min left`;
  }

  /**
   * Completion event: guard against a stale job, then on success reload the sidecar (the file
   * is the single source of truth) and on failure show the verbatim message with Try again.
   */
  private onTranscribeComplete(d: { jobId: string; exitCode: number; result: any; errorMessage?: string }): void {
    if (!d || d.jobId !== this.transcribeJobId) return;
    this.transcribeJobId = null;
    if (d.exitCode === 0 && d.result) {
      // Reload from disk rather than trusting the IPC result payload.
      if (this.currentZipPath) void this.loadTranscriptForSession(this.currentZipPath, this.bootstrapGeneration);
    } else {
      this.transcriptState = 'error';
      this.transcriptError = d.errorMessage || 'Transcription failed.';
      this.cdr.detectChanges();
    }
  }

  /**
   * Click a transcript group → select its span on the timeline (the group's ORIGINAL
   * [start, end] mapped through originalToEdited into selStart/selEnd, so the yellow overlay
   * highlights it), move the playhead to the selection start, scroll it into view, and mark
   * the group selected. A group whose span collapses under cuts still seeks (no range).
   */
  selectGroup(g: TranscriptGroupView): void {
    const lo = this.originalToEdited(g.originalStart);
    const hi = this.originalToEdited(g.originalEnd);
    this.selectedRanges = [];        // the group replaces any marquee selection
    if (hi - lo > this.EPS) {
      this.selStart = lo;
      this.selEnd = hi;
    } else {
      this.selStart = null;
      this.selEnd = null;
    }
    this.selectedGroupStart = g.originalStart;
    this.selectedGroupEnd = g.originalEnd;
    this.setPlayhead(lo);           // also re-anchors playback + requests a render
    this.ensureSelectionVisible();
  }

  /** True when a rendered group is the one currently reflected in the timeline selection. */
  isGroupSelected(g: TranscriptGroupView): boolean {
    return this.selectedGroupStart !== null
      && Math.abs(this.selectedGroupStart - g.originalStart) <= this.EPS
      && this.selectedGroupEnd !== null
      && Math.abs(this.selectedGroupEnd - g.originalEnd) <= this.EPS;
  }

  /** Scroll so the current selection is on screen (reuses clampScroll). No-op if none. */
  private ensureSelectionVisible(): void {
    const r = this.selRange();
    if (!r) return;
    const left = this.scrollOffset;
    const right = this.scrollOffset + this.viewportSec;
    if (r.lo < left || r.hi > right) {
      this.scrollOffset = this.clampScroll(r.lo - this.viewportSec * 0.1);
      this.requestRender();
    }
  }

  /** "N results" count for the search UI (visible groups when a query is active). */
  get searchResultCount(): number {
    return this.visibleGroups.length;
  }

  // ── Playback (element-based jump-cuts) ──────────────────────────────────────
  togglePlayback(): void {
    if (this.isPlaying) this.stopPlayback();
    else this.startPlayback();
  }

  private startPlayback(): void {
    if (!this.manifest) return;
    this.transportError = '';
    // Starting at (or past) the end restarts from the top.
    if (this.playheadTime >= this.editedDuration - 1e-3) {
      this.playheadTime = 0;
    }
    this.isPlaying = true;
    this.playAnchorPerfMs = performance.now();
    this.playAnchorTime = this.playheadTime;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = requestAnimationFrame(this.tick);
  }

  private stopPlayback(): void {
    this.isPlaying = false;
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    const v = this.viewerVideoRef?.nativeElement;
    if (v) { try { v.pause(); } catch { /* already paused */ } }
    for (const el of this.audioEls.values()) { try { el.pause(); } catch { /* gone */ } }
  }

  /** rAF loop: advance the timeline clock off performance.now() and sync every element. */
  private tick = (): void => {
    if (!this.isPlaying || !this.manifest) { this.rafId = null; return; }
    const elapsed = (performance.now() - this.playAnchorPerfMs) / 1000;
    let t = this.playAnchorTime + elapsed;
    if (t >= this.editedDuration) {
      t = this.editedDuration;
      this.playheadTime = t;
      this.syncElements(t, false); // park everything at the end
      this.stopPlayback();
      this.requestRender();
      this.cdr.detectChanges();
      return;
    }
    this.playheadTime = t;
    this.syncElements(t, true);
    this.requestRender();
    this.rafId = requestAnimationFrame(this.tick);
  };

  /**
   * Position (and, when playing, run) the media elements for timeline time t.
   * VIDEO track → the viewer <video>; each AUDIO track → its file's <audio> element.
   * A gap on a track pauses that element (video holds its last frame).
   */
  private syncElements(t: number, playing: boolean): void {
    // PRIMARY video track only — overlay video layers are timeline-only in v1 (the
    // viewer is not a compositor).
    if (this.primaryVideoTrackId) {
      const vseg = this.segmentAt(this.primaryVideoTrackId, t);
      this.syncViewer(vseg, t, playing);
    }
    // Audio tracks: gather the file → desired-time needed this instant.
    const needed = new Map<string, number>();
    for (const trackId of this.audioTrackIds) {
      const seg = this.segmentAt(trackId, t);
      if (seg) needed.set(seg.file, seg.sourceStart + (t - seg.timelineStart));
    }
    // Pause any element whose file is not needed right now.
    for (const [file, el] of this.audioEls) {
      if (!needed.has(file)) { try { el.pause(); } catch { /* gone */ } }
    }
    if (!playing) {
      // Paused: audio is silent; only the viewer scrubs. Do not start audio elements.
      return;
    }
    for (const [file, desired] of needed) {
      const el = this.ensureAudioEl(file);
      if (!el) return; // load failure already surfaced + playback stopped
      if (Math.abs(el.currentTime - desired) > this.SEEK_TOLERANCE) {
        try { el.currentTime = Math.max(0, desired); } catch { /* not seekable yet */ }
      }
      if (el.paused) {
        el.play().catch((e: any) => this.onMediaError(`Audio track (${file}) failed to play: ${e?.message || e}`));
      }
    }
  }

  private syncViewer(seg: EditorSegment | null, t: number, playing: boolean): void {
    const v = this.viewerVideoRef?.nativeElement;
    if (!v) return;
    v.muted = true; // the hybrid's sound lives on the audio lanes
    if (!seg) {
      // Gap: hold the last frame (just pause; do not blank the element).
      if (playing) { try { v.pause(); } catch { /* already */ } }
      return;
    }
    if (this.viewerLoadedFile !== seg.file) {
      v.onerror = () => this.onMediaError(`Could not load video: ${seg.file}`);
      v.src = this.pathToFileUrl(seg.file);
      this.viewerLoadedFile = seg.file;
    }
    const desired = seg.sourceStart + (t - seg.timelineStart);
    if (Math.abs(v.currentTime - desired) > this.SEEK_TOLERANCE) {
      try { v.currentTime = Math.max(0, desired); } catch { /* not seekable yet */ }
    }
    if (playing) {
      if (v.paused) v.play().catch((e: any) => this.onMediaError(`Video playback failed: ${e?.message || e}`));
    } else {
      try { v.pause(); } catch { /* already */ }
    }
  }

  /** Get (or lazily create) the <audio> element for a file. Returns null on hard failure. */
  private ensureAudioEl(file: string): HTMLAudioElement | null {
    let el = this.audioEls.get(file);
    if (el) return el;
    el = new Audio();
    el.muted = false; // audio elements ARE the sound
    el.preload = 'auto';
    el.onerror = () => this.onMediaError(`Could not load audio: ${file}`);
    el.src = this.pathToFileUrl(file);
    this.audioEls.set(file, el);
    return el;
  }

  /** A media element failed: stop playback and surface the message (no silent continue). */
  private onMediaError(message: string): void {
    if (!this.transportError) this.transportError = message;
    this.stopPlayback();
    this.cdr.detectChanges();
  }

  /** While paused, park the viewer video on the PRIMARY-track frame under the playhead. */
  private seekViewerToPlayhead(): void {
    if (this.isPlaying || !this.primaryVideoTrackId) return;
    const seg = this.segmentAt(this.primaryVideoTrackId, this.playheadTime);
    this.syncViewer(seg, this.playheadTime, false);
  }
}
