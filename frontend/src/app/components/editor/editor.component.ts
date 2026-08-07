import {
  Component, OnInit, OnDestroy, AfterViewInit, ViewChild, ElementRef, HostListener, ChangeDetectorRef
} from '@angular/core';
import { Subscription } from 'rxjs';
import { ElectronService } from '../../services/electron.service';
import { ProcessingService, ProcessingJob } from '../../services/processing.service';
import { ProjectsService, ProjectEntry } from '../../services/projects.service';
import { ProjectSidebarComponent } from '../project-sidebar/project-sidebar.component';
import { EditorManifest, EditorSegment } from '../../models/editor-manifest';
import {
  TranscriptWord, Transcript, TranscriptGroup, TranscriptGroupView,
  TranscriptState, RecentSession, ToolMode, Cut, Story, StoryChapter,
  KeptInterval, EditSnapshot, ActivityEntry, TrackRow, MoveDrag
} from './model/editor-types';
import {
  EPS, mergeRanges, mergeRegions, mergeCuts, nearestBoundary, normalizeSequence, segmentAtIn,
  isMultiPick, isTypingTarget
} from './model/editor-math';
import {
  pad2, formatRulerLabel, formatTimecode, fmtClock, pathToFileUrl,
  cleanChapterLabel, prettyLabel, deriveName
} from './model/editor-format';
import {
  storyColor, storiesForDisplay, isStoryEmpty, regionFingerprint, storyChapterState,
  storyApproxChapters, setStoryChapters, toStoryChapters, clipStoryChapters
} from './model/story-utils';
import { TranscriptPaneComponent } from './transcript-pane/transcript-pane.component';
import { WaveformCache } from './timeline/waveform-cache';
import { TimelineRenderer } from './timeline/timeline-renderer';
import { TimelineScene } from './timeline/timeline-scene';
import {
  GUTTER_W, RULER_H, RIBBON_H, VIDEO_TRACK_H, AUDIO_TRACK_H, ZOOM_MAX
} from './timeline/timeline-metrics';

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

@Component({
  selector: 'app-editor',
  standalone: false,
  templateUrl: './editor.component.html',
  styleUrl: './editor.component.scss'
})
export class EditorComponent implements OnInit, AfterViewInit, OnDestroy {
  // The FCP visual constants live in timeline/timeline-metrics.ts (one home, shared with the
  // renderer). GUTTER_W is re-exposed as a field because the template binds it — strictTemplates
  // cannot read an imported const.
  readonly GUTTER_W = GUTTER_W;

  // Playback / scrub sync tolerance (seconds) before we re-seek an element.
  private readonly SEEK_TOLERANCE = 0.08;

  @ViewChild('timelineCanvas') canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('viewerVideo') viewerVideoRef!: ElementRef<HTMLVideoElement>;
  @ViewChild('topRegion') topRegionRef?: ElementRef<HTMLElement>;
  /**
   * The transcript body, when it is rendered (Edit tab, session loaded). Optional and always
   * reached with `?.` — the karaoke scroll fires from the rAF tick, which runs while the pane
   * is behind its *ngIf (Stories tab) or not yet created.
   */
  @ViewChild(TranscriptPaneComponent) transcriptPane?: TranscriptPaneComponent;

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
  errorMessage = '';        // failed load — shown in the workspace; sidebar/topbar stay live
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
  // Public because the projects sidebar takes it as an input for the active-row highlight.
  currentZipPath: string | null = null;
  // Monotonic bootstrap generation: a re-init mid-load invalidates the older load so a
  // slow stale manifest can never clobber the newer session.
  private bootstrapGeneration = 0;

  // ── Edit model (cuts × sequence → edited timeline) ──────────────────────────
  // `cuts` (what survives, ORIGINAL frames, sorted+merged) and `sequence` (what order it plays
  // in) are the two sources of edit truth. Everything derived — segsByTrack above,
  // editedDuration, both kept-span indexes — is rebuilt from the pair by rebuildEditedModel().
  cuts: Cut[] = [];
  editedDuration = 0;                    // seconds; == manifest.timelineDuration with zero cuts
  // The same kept spans indexed two ways (SAME objects, two orders) — see KeptInterval.
  private keptBySequence: KeptInterval[] = [];   // ascending `es` === playback order
  private keptByOriginal: KeptInterval[] = [];   // ascending `os`
  /**
   * Playback ORDER of the timeline, as a partition of [0, timelineDuration] in ORIGINAL seconds:
   * entry i plays before entry i+1. null === source order — the overwhelmingly common case, and
   * what an absent sidecar field restores, so every project written before reordering existed
   * loads byte-identically.
   *
   * INVARIANT: the entries tile [0, timelineDuration] exactly — no gaps, no overlaps. That is
   * what keeps cuts purely SUBTRACTIVE (rebuildEditedModel intersects the sequence with the cut
   * complement rather than editing the sequence), so undoing a cut restores its footage to the
   * slot it was lifted from instead of losing its place in the order.
   */
  private sequence: { start: number; end: number }[] | null = null;
  private readonly UNDO_LIMIT = 100;
  // Undo/redo snapshots the cut list, the blade boundaries AND the sequence, so Cmd+Z reverses
  // whichever an action changed — a ripple delete, a dropped blade, or a reorder.
  private undoStack: EditSnapshot[] = [];
  private redoStack: EditSnapshot[] = [];

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
  // True when the in-flight marquee is a Story-Mode paint (drop → a story region) rather than
  // a cut selection. Set at mousedown, consumed + cleared at mouseup.
  private marqueeForStory = false;
  // In-flight story-region edge drag (grabbed an edge in the ribbon). The story's regions are
  // canonicalized (merged) at grab time so regionIndex addresses story.regions directly.
  private draggingStoryEdge: { storyId: string; regionIndex: number; edge: 'start' | 'end' } | null = null;
  /**
   * In-flight "move this footage somewhere else" drag: grabbed inside an existing highlight with
   * the Select tool. `ranges` is frozen at grab time (the live selection would follow the model
   * out from under the gesture), `boundaries` is the section grid frozen for the same reason AND
   * because sectionBoundaries() rebuilds and re-sorts every clip edge — not a per-mousemove cost.
   * `moved` gates the commit on the same 3px promotion threshold the marquee uses, so a click
   * inside a highlight still falls through to plain scrub + section select.
   */
  private moveDrag: MoveDrag | null = null;

  // ── Edit-state persistence (<session>_edits.json sidecar) ────────────────────
  // Everything the user builds in the editor — cuts, blades, stories, and the undo/redo
  // stacks — persists across sessions in a sidecar next to the zip (same pattern as the
  // transcript/alignment sidecars; the zip itself stays immutable). Restored on load;
  // saved debounced after every mutation. Suppressed during load/restore so ingest
  // doesn't immediately re-write what it just read.
  private editsSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private suppressEditsSave = false;
  private static readonly EDITS_SCHEMA_VERSION = 1;

  // ── Snapping (story edges + range highlighting stick to cut boundaries) ──────
  // Snap radius in CSS px (converted to seconds at the current zoom in snapEdited).
  private readonly SNAP_PX = 8;
  // Sorted, deduped snap targets in EDITED seconds: video-track clip edges (auto-editor
  // cuts; segments split at kept boundaries so user-cut seams are edges too), the kept
  // seams themselves (covers seams inside clip gaps), and the timeline ends. Rebuilt with
  // the edit model; blade boundaries are folded in live (they mutate independently).
  private snapPoints: number[] = [];

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
  // Public only because the template feeds them to app-transcript-pane, which owns the
  // highlight test (strictInputAccessModifiers rejects a private member in a binding).
  selectedGroupStart: number | null = null;
  selectedGroupEnd: number | null = null;

  // ── Export ──────────────────────────────────────────────────────────────────
  exporting = false;
  exportResultPath: string | null = null; // set on a successful FCPXML export
  exportError: string | null = null;       // Python's message, verbatim, on failure
  // Disabled mic blocks the export actually emitted, straight from the result JSON. null =
  // the mute pass did not run; 0 is a REAL value and is shown as such.
  exportMicMuteBlocks: number | null = null;
  // File ▸ Export… chooser modal (pick Master FCPXML vs Stories).
  exportChooserOpen = false;
  // Mute the mic wherever the SCREEN track is speaking and the mic is not. ON by default:
  // it is the manual cleanup pass this editor exists to remove, and every block it makes is
  // one FCPX clip you re-enable with a single press of V if it got one wrong. Requires the
  // transcript sidecar — the export fails loudly (never quietly skips) without one, so the
  // checkbox is disabled until transcription has run.
  muteMicDuringScreen = true;
  // Top-bar File menu (Export / Open) open/closed state.
  menuOpen = false;

  // ── Stories (mark/name/number spans; ORIGINAL seconds) ───────────────────────
  // Each story owns explicit disjoint `regions`. `number` is the user-facing project
  // ordering. Purely additive UI state: nothing here touches the cut model, playback, export
  // IPC, or any data contract. Reset on session re-init.
  stories: Story[] = [];
  private storyIdCounter = 0;          // monotonic id source (reset per session)
  // Story Mode is the THIRD pointer tool (alongside Select and Blade). While the tool is
  // 'story', a canvas drag paints a region into the ACTIVE story (activeStoryId), or starts a
  // new story when none is active. `storyMode` is DERIVED from toolMode (see getter) so the
  // tabs, ribbon and paint logic all track the single tool state.
  activeStoryId: string | null = null;
  // A selected story for delete: `regionIndex` null = the WHOLE story (notch click), a number =
  // one CHUNK (ribbon-bar click), addressing the story's CANONICAL (merged) regions. Delete /
  // Cmd+X act on THIS (a chunk removes just that region; a whole selection removes the story) —
  // never rippling the timeline. Cleared by any other canvas gesture, Escape, or session reset.
  storySelection: { storyId: string; regionIndex: number | null } | null = null;
  // Stories ticked for merging. Deliberately separate from `storySelection` (which drives region
  // editing and paint targeting) so ticking a box never disturbs what the timeline is showing.
  storyMergeIds = new Set<string>();

  // ── Story analysis (local Ollama LLM) ────────────────────────────────────────
  // Chapter splitting + title suggestions. Ollama-only for now (no downloads); the model is the
  // user's choice from their locally-pulled models.
  ollamaModels: { id: string; name: string }[] = [];
  ollamaConnected = false;
  selectedOllamaModel = '';
  // Key is versioned: v2 introduced the cogito:14b default, and a model saved under the old key
  // would have silently outranked it forever. Bumping re-defaults everyone exactly once; the next
  // pick they make sticks.
  private readonly OLLAMA_MODEL_KEY = 'editor.ollamaModel.v2';
  analyzing = false;
  analyzeMessage = '';
  analyzeError: string | null = null;
  // Set by the stop button; checked between stories in the titling loop so a stop takes effect
  // immediately rather than after every remaining story has been titled.
  private analyzeStopRequested = false;
  // Determinate progress for a running analysis (chapter split or auto-split). The chapter
  // pipeline is many small single-question model calls — one per 45s stretch, per junction, per
  // boundary, per chapter, per adjacent pair — so `total` runs into the hundreds on a long
  // recording and is revised upward if consolidation merges (a merge adds a re-naming call).
  // Shared — only one analysis runs at a time.
  aiProgressDone = 0;
  aiProgressTotal = 0;
  aiPhase = '';
  get aiProgressPct(): number {
    return this.aiProgressTotal > 0 ? Math.min(100, Math.round((this.aiProgressDone / this.aiProgressTotal) * 100)) : 0;
  }

  // Split modal — assign detected chapters to stories (any non-contiguous subset). `splitBuckets`
  // are the target stories ([0] = the story being split); `splitAssign[i]` is chapter i's bucket
  // index, or -1 for excluded (scrap).
  splitModalOpen = false;
  splitRunning = false;
  splitError: string | null = null;
  private splitStory: Story | null = null;
  splitStoryTitle = '';
  // `subChapters` is carried but never shown in the modal — the user assigns whole chapters; the
  // fine tier just needs to reach whichever story the chapter lands in.
  splitChapters: { index: number; startSeconds: number; endSeconds: number; label: string; subChapters?: StoryChapter[] }[] = [];
  splitAssign: number[] = [];
  splitBuckets: { title: string; touched?: boolean }[] = [];
  splitActiveBucket = 0;
  // The regions that were ANALYZED for the open split (the intersection basis for Apply — stays the
  // original span even after Apply shrinks the story, so a rework redistributes the full chapter set).
  private splitAnalyzedRegions: { start: number; end: number }[] = [];
  // True when the open modal is showing a CACHED analysis (no fresh model run) — surfaces a hint.
  splitFromCache = false;

  // ── Transcript ────────────────────────────────────────────────────────────
  // Stable per-track-id color, assigned by discovery order and cycled for extra tracks.
  private readonly TRACK_COLORS = ['#e8a33d', '#4a9eff', '#7bc98f', '#c98fd6', '#d67b7b', '#7bd6cf'];
  transcriptState: TranscriptState = 'none';
  private transcript: Transcript | null = null;
  // All groups in timeline order (immutable per loaded transcript). visibleGroups is the
  // cut-aware, timecoded projection the template renders — recomputed whenever cuts change.
  private transcriptGroups: TranscriptGroup[] = [];
  visibleGroups: TranscriptGroupView[] = [];
  // Index into visibleGroups of the line the playhead currently sits in (-1 = before the
  // first line). Drives the karaoke highlight and the auto-scroll while playing.
  activeGroupIdx = -1;
  private lastScrolledGroupIdx = -1;
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
  recents: RecentSession[] = [];

  // ── Rendering ───────────────────────────────────────────────────────────────
  private renderScheduled = false;

  // ── Waveform cache ──────────────────────────────────────────────────────────
  private waveforms = new WaveformCache(
    o => this.electron.alignmentExtractPeaks(o),
    () => this.requestRender(),
  );
  private renderer = new TimelineRenderer((seg, onScreenW) => this.waveforms.getOrRequest(seg, onScreenW));

  // ── Activity window (FCPX-style background-task HUD) ─────────────────────────
  // A floating, draggable dock. Auto-opens when transcription starts; drag by its header
  // to reposition (offsets from its default top-center anchor). Closed with its × only.
  activityOpen = false;
  activityX = 0;
  activityY = 0;
  // The story-analysis queue: one entry per story a run will visit, [0] running, the rest waiting.
  // Emptied whenever a run ends (finished, failed or stopped) so ghost rows cannot outlive it.
  activityQueue: ActivityEntry[] = [];
  // Stories the user X'd out of the CURRENT run — a per-story cancel, as opposed to the dock's
  // stop button which ends the whole run. A pending story in here is simply never visited; the
  // running one is aborted the same way a stop aborts it, and the loops tell the two intents
  // apart by looking here. Cleared whenever a new run seeds the queue.
  activitySkipRequested = new Set<string>();
  // The dock is 360px wide and shares it with transcription/export/waveform blocks, so a 40-story
  // session lists the next few and counts the rest.
  private readonly ACTIVITY_PENDING_SHOWN = 6;

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

  /** The projects sidebar rendered inside the project pane — the File menu drives its add flow
      through this so a rejected folder reports in the pane, not in a lost promise. */
  @ViewChild(ProjectSidebarComponent) projectSidebar?: ProjectSidebarComponent;

  // ── Project processing (the setup modal + the pane's busy row) ──────────────
  /** The project the setup modal is open on; null = closed. */
  setupEntry: ProjectEntry | null = null;
  /** True when the modal is being reopened onto a run already in flight for that project. */
  setupAttachRunning = false;
  /** The project whose job is running, fed to the pane as a spinner + percent. */
  projectBusyPath: string | null = null;
  projectBusyPercent: number | null = null;
  /**
   * Which project the CURRENT processing job belongs to. ProcessingService has no notion of a
   * project, so ownership is recorded here when the modal reports it started a run, and dropped
   * the moment that job reaches a terminal state.
   */
  private processingEntryPath: string | null = null;
  private jobSub?: Subscription;

  constructor(
    private electron: ElectronService,
    private projectsService: ProjectsService,
    private processing: ProcessingService,
    private cdr: ChangeDetectorRef
  ) {}

  // ── Lifecycle ───────────────────────────────────────────────────────────────
  async ngOnInit(): Promise<void> {
    // Restore pane-split preferences (validated + clamped; fall back on anything odd).
    this.splitV = this.readSplit(this.SPLIT_V_KEY, this.SPLIT_V_MIN, this.SPLIT_V_MAX, this.SPLIT_V_DEFAULT);
    this.splitH = this.readSplit(this.SPLIT_H_KEY, this.SPLIT_H_MIN, this.SPLIT_H_MAX, this.SPLIT_H_DEFAULT);
    this.projectWidth = this.readSplit(this.SPLIT_P_KEY, this.SPLIT_P_MIN, this.SPLIT_P_MAX, this.SPLIT_P_DEFAULT);
    // Recents (pruned against disk) still feed the OLD launcher page; kept until it moves over.
    void this.loadAndPruneRecents();
    // The project pane's real source of truth: the on-disk projects registry. Reads, scans
    // every folder, and (once) folds the legacy recents in.
    void this.projectsService.load();
    // Processing progress for the project pane's busy row. Only the job this window started
    // (through the setup modal) is attributed to a project — see processingEntryPath.
    this.jobSub = this.processing.getCurrentJob().subscribe(job => this.onProcessingJob(job));
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
    // Load the local Ollama model list for the Stories-tab analyzer (non-blocking; the picker
    // shows "is Ollama running?" until it connects).
    void this.refreshOllamaModels();
    // Per-step progress of a running chapter analysis → the modal bar + activity dock.
    this.electron.onStoryAnalyzeProgress((p) => {
      this.aiProgressDone = p.done;
      this.aiProgressTotal = p.total;
      this.aiPhase = p.phase;
      this.cdr.detectChanges();
    });
    try {
      const res = await this.electron.getEditorPayload();
      if (res?.zipPath && res.zipPath !== this.currentZipPath) {
        await this.bootstrap(res.zipPath);
      } else if (!res?.zipPath && !this.currentZipPath) {
        // Blank open (side-nav Editor button): no session was requested. Show the
        // no-session workspace — projects sidebar live, viewer/timeline replaced by a
        // hint. A payload can still arrive via the push listener and bootstraps then.
        this.loading = false;
      }
    } catch (err: any) {
      this.fail(`Could not load the session: ${err?.message || err}`);
    }
  }

  ngAfterViewInit(): void {
    this.requestRender();
  }

  ngOnDestroy(): void {
    this.jobSub?.unsubscribe();
    this.stopPlayback();
    window.removeEventListener('mousemove', this.onWindowMouseMove);
    window.removeEventListener('mouseup', this.onWindowMouseUp);
    document.body.style.userSelect = ''; // in case we're destroyed mid-splitter-drag
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    for (const el of this.audioEls.values()) { try { el.pause(); el.src = ''; } catch { /* gone */ } }
    this.audioEls.clear();
    this.electron.removeEditorListeners();
    this.electron.removeTranscribeListeners();
    this.electron.removeStoryAnalyzeProgressListener();
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
    // Restore persisted edit state (cuts/blades/stories/undo/redo). No sidecar = a session
    // never edited before -> fresh state. A sidecar that exists but cannot be read/parsed
    // is a REAL error and fails the load loudly (fix or delete the file).
    try {
      const edits = await this.electron.loadEditorEdits({ zipPath });
      if (generation !== this.bootstrapGeneration) return;
      if (edits !== null) this.restoreEdits(edits);
    } catch (err: any) {
      if (generation !== this.bootstrapGeneration) return;
      this.fail(err?.message || String(err));
      return;
    }
    this.loading = false;
    // Remember this session in the shared recents (updates lastOpened + re-sorts), so the
    // project picker always shows the currently-loaded one highlighted at the top.
    this.recordRecent(zipPath);
    // Same stamp against the projects registry, so the pane re-sorts the row to the top. A zip
    // that belongs to no registered project matches nothing and is simply not recorded there.
    void this.projectsService.markOpened(zipPath);
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
    this.waveforms.clear();
    this.activeGroupIdx = -1;
    this.lastScrolledGroupIdx = -1;
    this.activityOpen = false;
    this.activityX = 0;
    this.activityY = 0;
    this.activityQueue = [];
    this.playheadTime = 0;
    this.scrollOffset = 0;
    this.errorMessage = '';
    this.transportError = '';
    // Edit state: a re-init starts the new session with an untouched timeline.
    this.cuts = [];
    this.keptBySequence = [];
    this.keptByOriginal = [];
    this.sequence = null;
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
    this.exportChooserOpen = false;
    this.exportMicMuteBlocks = null;
    // Back to the default (mute armed) — an "off" choice is per-session state and is
    // restored from the new session's sidecar, never carried over from the previous one.
    this.muteMicDuringScreen = true;
    this.menuOpen = false;
    // Stories are per-session and NOT persisted (v1) — a re-init starts with none.
    this.stories = [];
    this.storyIdCounter = 0;
    this.toolMode = 'select';
    this.activeStoryId = null;
    this.storySelection = null;
    this.marqueeForStory = false;
    this.draggingStoryEdge = null;
    this.moveDrag = null;
    // A pending debounced save belongs to the PREVIOUS session — never let it fire
    // across a switch (it would snapshot post-reset state).
    if (this.editsSaveTimer !== null) { clearTimeout(this.editsSaveTimer); this.editsSaveTimer = null; }
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
   * The effective playback sequence: the stored order, or the single whole-timeline entry that IS
   * source order. Never null, so every walk over it has exactly one shape and the no-sequence case
   * is not a second code path that can drift.
   */
  private sequenceSpans(): { start: number; end: number }[] {
    if (this.sequence && this.sequence.length > 0) return this.sequence;
    return [{ start: 0, end: this.manifest?.timelineDuration || 0 }];
  }

  /**
   * Rebuild every derived edit artifact from `sequence` × `cuts`: the kept-span indexes,
   * editedDuration, the per-track edited segments, and (implicitly) the
   * editedToOriginal/originalToEdited maps that read them. A manifest segment [ts, ts+d) is
   * intersected with each kept span; every non-empty intersection is one edited segment whose
   * sourceStart carries the offset into the media file, so jump-cut playback across removed (and
   * relocated) ranges is automatic.
   */
  private rebuildEditedModel(): void {
    const m = this.manifest;
    if (!m) {
      this.keptBySequence = []; this.keptByOriginal = [];
      this.editedDuration = 0; this.segsByTrack.clear();
      return;
    }
    const fs = m.frameSeconds;

    // Walk the sequence in PLAYBACK order and subtract the cuts from each entry, so the edited
    // write head `acc` accumulates in SEQUENCE order rather than source order. With no sequence
    // this is one entry spanning [0, timelineDuration] and the body reduces to the old
    // complement-of-cuts walk, emitting the identical list.
    const seq = this.sequenceSpans();
    const kept: KeptInterval[] = [];
    let acc = 0;
    for (let s = 0; s < seq.length; s++) {
      const end = seq[s].end;
      let cursor = seq[s].start;
      for (const c of this.cuts) {
        const cs = c.startFrame * fs;
        const ce = c.endFrame * fs;
        if (ce <= cursor) continue;        // wholly before what's left of this entry
        if (cs >= end) break;              // cuts are sorted; nothing further overlaps the entry
        if (cs > cursor + EPS) {
          const len = cs - cursor;
          kept.push({ os: cursor, oe: cs, es: acc, ee: acc + len, seq: s });
          acc += len;
        }
        if (ce > cursor) cursor = ce;      // may overshoot `end`; the tail guard below catches it
      }
      if (end > cursor + EPS) {
        const len = end - cursor;
        kept.push({ os: cursor, oe: end, es: acc, ee: acc + len, seq: s });
        acc += len;
      }
    }
    this.keptBySequence = kept;                                   // already ascending in `es`
    this.keptByOriginal = [...kept].sort((a, b) => a.os - b.os);  // a no-op copy in source order
    this.editedDuration = acc;

    // Split each original segment against the kept spans, indexed by ORIGINAL start so the
    // `break` still prunes the scan.
    this.segsByTrack.clear();
    for (const [trackId, segs] of this.originalSegsByTrack) {
      const out: EditorSegment[] = [];
      for (const seg of segs) {
        const ts = seg.timelineStart;
        const te = ts + seg.duration;
        for (const iv of this.keptByOriginal) {
          if (iv.os >= te) break;          // sorted by os; nothing further overlaps
          if (iv.oe <= ts) continue;
          const os = Math.max(ts, iv.os);
          const oe = Math.min(te, iv.oe);
          if (oe - os <= EPS) continue;
          out.push({
            trackId: seg.trackId,
            timelineStart: iv.es + (os - iv.os),   // rippled AND resequenced position
            duration: oe - os,
            file: seg.file,
            sourceStart: seg.sourceStart + (os - ts),
            label: seg.label,
          });
        }
      }
      // Pieces were emitted in ORIGINAL order but land at their SEQUENCE position, so the lane is
      // no longer self-sorting. It MUST end up ascending in timelineStart: segmentAt() binary-
      // searches it, and an unsorted lane would sync the wrong clip under the playhead. Already
      // sorted in source order, where this is a no-op pass.
      out.sort((a, b) => a.timelineStart - b.timelineStart);
      this.segsByTrack.set(trackId, out);
    }
    this.rebuildSnapPoints();
    // Transcript group visibility + edited timecodes depend on the cut model — re-derive
    // them here so they stay in lockstep with every cut/undo/redo (no-op before load).
    this.recomputeVisibleGroups();
    // Every cut-model change persists (debounced; suppressed during load/restore).
    this.scheduleEditsSave();
  }

  /** Rebuild the sorted/deduped snap-target list (see snapPoints). */
  private rebuildSnapPoints(): void {
    const pts: number[] = [0, this.editedDuration];
    const videoTrack = this.manifest?.tracks.find(tr => tr.kind === 'video');
    const segs = videoTrack ? this.segsByTrack.get(videoTrack.id) : undefined;
    if (segs) {
      for (const s of segs) { pts.push(s.timelineStart, s.timelineStart + s.duration); }
    }
    for (const iv of this.keptBySequence) { pts.push(iv.es, iv.ee); }
    pts.sort((a, b) => a - b);
    const out: number[] = [];
    for (const p of pts) {
      if (out.length === 0 || p - out[out.length - 1] > EPS) out.push(p);
    }
    this.snapPoints = out;
  }

  /**
   * Snap an EDITED-seconds time to the nearest cut boundary (clip edge / cut seam / blade).
   * Default radius is SNAP_PX at the current zoom; `radiusPx = Infinity` HARD-quantizes (the
   * story gestures — a story either takes a whole section or none of it, so its edges may
   * only ever sit on a boundary). `bypass` (Option during soft-snap drags) disables it.
   */
  private snapEdited(t: number, bypass = false, radiusPx = this.SNAP_PX): number {
    if (bypass) return t;
    let best = t;
    let bestD = radiusPx / this.pxPerSec;
    const pts = this.snapPoints;
    if (pts.length > 0) {
      // Binary-search the insertion point, then only its neighbors can be nearest.
      let lo = 0, hi = pts.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid] < t) lo = mid + 1; else hi = mid; }
      for (const i of [lo - 1, lo, lo + 1]) {
        if (i < 0 || i >= pts.length) continue;
        const d = Math.abs(pts[i] - t);
        if (d < bestD) { bestD = d; best = pts[i]; }
      }
    }
    for (const b of this.bladeBoundaries) {          // few — linear is fine
      const e = this.originalToEdited(b);
      const d = Math.abs(e - t);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  /** EDITED seconds → ORIGINAL seconds (piecewise, binary-searched over the SEQUENCE index). */
  private editedToOriginal(e: number): number {
    const iv = this.keptBySequence;
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
   * ORIGINAL seconds → EDITED seconds (binary-searched over the ORIGINAL index). A time inside a
   * removed range collapses to that cut's seam (the edited position where the removed content used
   * to begin), which is exactly the landing spot after a ripple delete.
   *
   * Single-valued and therefore only meaningful for a POINT. Once footage is reordered this map is
   * no longer monotonic, so a caller mapping both ends of a span and treating [lo, hi] as the
   * result can get hi < lo — anything spanning a range must use editedRangesForOriginal().
   */
  private originalToEdited(t: number): number {
    const iv = this.keptByOriginal;
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

  /**
   * An ORIGINAL span projected onto the edited timeline as the merged, ascending list of edited
   * ranges its surviving pieces occupy.
   *
   * In source order this always collapses to the single range
   * [originalToEdited(start), originalToEdited(end)] — the cut-swallowed middles have zero edited
   * width and the flanking pieces re-merge across them — so it is a drop-in generalization of what
   * every caller used to do by hand. Once footage is reordered one span CAN land in several places,
   * and a caller still holding [O2E(start), O2E(end)] would compute a negative-width block and
   * silently drop it (the stories ribbon) or fail every hit-test against it.
   */
  private editedRangesForOriginal(start: number, end: number): { lo: number; hi: number }[] {
    const out: { lo: number; hi: number }[] = [];
    for (const iv of this.keptByOriginal) {
      if (iv.os >= end - EPS) break;        // sorted by os; nothing further overlaps
      if (iv.oe <= start + EPS) continue;
      const os = Math.max(start, iv.os);
      const oe = Math.min(end, iv.oe);
      if (oe - os <= EPS) continue;
      out.push({ lo: iv.es + (os - iv.os), hi: iv.es + (oe - iv.os) });
    }
    return mergeRanges(out);
  }

  /**
   * An EDITED range projected back onto the original timeline as the ORIGINAL spans it covers.
   *
   * Contiguous in edited time does NOT imply contiguous in original time once footage has been
   * reordered: a ripple delete that mapped only the two edges would manufacture a cut spanning
   * everything between two relocated blocks and erase footage the user never selected. In source
   * order this returns exactly one span, matching what editedToOriginal gives for each edge.
   */
  private originalSpansForEdited(lo: number, hi: number): { start: number; end: number }[] {
    const iv = this.keptBySequence;
    const out: { start: number; end: number }[] = [];
    if (iv.length === 0 || hi - lo <= EPS) return out;
    // First span whose edited end is past `lo`; from there the walk is contiguous in `es`.
    let a = 0, b = iv.length - 1, first = iv.length;
    while (a <= b) {
      const mid = (a + b) >> 1;
      if (iv[mid].ee > lo + EPS) { first = mid; b = mid - 1; } else { a = mid + 1; }
    }
    for (let i = first; i < iv.length; i++) {
      if (iv[i].es >= hi - EPS) break;
      const es = Math.max(lo, iv[i].es);
      const ee = Math.min(hi, iv[i].ee);
      if (ee - es <= EPS) continue;
      out.push({ start: iv[i].os + (es - iv[i].es), end: iv[i].os + (ee - iv[i].es) });
    }
    return out;
  }

  private fail(message: string): void {
    this.errorMessage = message;
    this.loading = false;
    this.stopPlayback();
    this.cdr.detectChanges();
  }

  /**
   * "Back to projects" on the fatal-error card: return to the no-session workspace so a
   * failed load doesn't dead-end the window — the sidebar is live again and another
   * project can be picked. The failed session's zipPath is cleared so re-clicking the
   * SAME project retries instead of short-circuiting on "already loaded".
   */
  dismissError(): void {
    // A load can fail AFTER the manifest was ingested (e.g. reading the edits sidecar), so
    // dismissing must discard the half-loaded session, not just the message — otherwise the
    // panes would render a session with no zipPath behind them.
    this.resetSessionState();
    this.errorMessage = '';
    this.loading = false;
    this.currentZipPath = null;
  }

  /** The session panes render only when a session is fully loaded and healthy. */
  get sessionReady(): boolean {
    return !!this.manifest && !this.loading && !this.errorMessage;
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
    // FCPX-style: center the whole track stack in the area below the ruler AND the stories
    // ribbon, so short stacks float in the middle instead of hugging the top. The offset is
    // baked into every row's `top`, so canvas draw + gutter (which both read trackRows / the
    // same offset getter) stay pixel-aligned. ribbonHeight is 0 with zero stories, so the
    // layout is byte-identical to before when no story exists.
    let y = RULER_H + this.ribbonHeight + this.trackTopOffset;
    for (const track of ordered) {
      const height = track.kind === 'video' ? VIDEO_TRACK_H : AUDIO_TRACK_H;
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
      h += t.kind === 'video' ? VIDEO_TRACK_H : AUDIO_TRACK_H;
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
    const avail = H - RULER_H - this.ribbonHeight;
    const stack = this.trackStackHeight();
    return avail > stack ? Math.floor((avail - stack) / 2) : 0;
  }

  /**
   * Height (CSS px) the stories ribbon occupies directly under the ruler: the fixed band
   * when any story exists, else 0 — so with zero stories the ribbon is hidden and the track
   * area sits exactly where it always did (byte-identical layout). Read by canvas draw, by
   * trackRows / trackTopOffset (which shift the whole track stack down by it), by ribbon
   * hit-testing, and by the DOM gutter's ribbon spacer — one source of truth.
   */
  get ribbonHeight(): number {
    return this.hasStories() ? RIBBON_H : 0;
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
  /**
   * Dynamic zoom floor: all the way out = the WHOLE edited timeline fits the viewport
   * (viewportWidth / editedDuration px/s). Capped at 1 so short sessions keep the old floor
   * (their fit zoom is above 1 anyway, so they can always fit too).
   */
  private get minZoom(): number {
    const dur = this.editedDuration;
    if (!(dur > 0)) return 1;
    return Math.min(1, this.viewportWidth / dur);
  }
  private clampZoom(v: number): number {
    return Math.min(ZOOM_MAX, Math.max(this.minZoom, v));
  }

  // ── Segment lookup (binary search over sorted segments) ─────────────────────
  private segmentAt(trackId: string, t: number): EditorSegment | null {
    return segmentAtIn(this.segsByTrack.get(trackId), t);
  }

  // ── Rendering (rAF-batched) ─────────────────────────────────────────────────
  private requestRender(): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    requestAnimationFrame(() => { this.renderScheduled = false; this.draw(); });
  }

  private draw(): void {
    const c = this.canvasRef?.nativeElement;
    if (!c || !this.manifest) return;
    this.renderer.draw(c, this.buildScene());
  }

  /**
   * Everything one frame needs, snapshotted from the shell's state. Built once per rAF tick.
   *
   * `stories` is storiesForDisplay() evaluated ONCE here rather than inside the ribbon loop, and
   * `storyRibbonPieces` stays a closure (not a pre-flattened list) so the ribbon still calls
   * editedRangesForOriginal once per region, in the same order, as many times as it does today.
   */
  private buildScene(): TimelineScene {
    return {
      rows: this.trackRows,
      segsByTrack: this.segsByTrack,
      scrollOffset: this.scrollOffset,
      pxPerSec: this.pxPerSec,
      playheadTime: this.playheadTime,
      ribbonHeight: this.ribbonHeight,
      bladeEdited: this.bladeBoundaries.map(b => this.originalToEdited(b)),
      selectionRanges: this.allSelectionRanges(),
      pendingMark: this.selStart != null ? this.selStart : (this.selEnd != null ? this.selEnd : null),
      marquee: {
        active: this.marqueeActive,
        moved: this.marqueeMoved,
        start: this.marqueeStartTime,
        end: this.marqueeEndTime,
      },
      moveDrag: this.moveDrag,
      stories: storiesForDisplay(this.stories),
      storyRibbonPieces: r => this.editedRangesForOriginal(r.start, r.end),
      activeStoryId: this.activeStoryId,
      mergePicked: this.storyMergeIds,
      hasStories: this.hasStories(),
    };
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
      if (hi - lo > EPS) ranges.push({ lo, hi });
    }
    const single = this.selRange();
    if (single) ranges.push(single);
    return mergeRanges(ranges);
  }

  /** Clear every trace of the current selection (single, marquee, and group highlight). */
  private clearSelection(): void {
    this.selStart = null;
    this.selEnd = null;
    this.selectedRanges = [];
    this.selectedGroupStart = null;
    this.selectedGroupEnd = null;
    this.storySelection = null;
  }

  /** Cancel an in-flight HIGHLIGHT gesture (a marquee or shift-drag range) without committing it —
   *  Escape mid-drag throws away an accidental highlight. Returns true if something was aborted.
   *  Leaves no selection behind. Story-edge drags and playhead scrubs are not "highlights" and
   *  are left to finish on mouseup. */
  private abortInFlightGesture(): boolean {
    if (!this.marqueeActive && !this.draggingSelection && !this.moveDrag) return false;
    // A move drag is abandoned WITHOUT clearing the selection: nothing was committed yet, and the
    // highlight the user is holding is what they'd have to re-make.
    if (this.moveDrag) {
      this.moveDrag = null;
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', this.onWindowMouseMove);
      window.removeEventListener('mouseup', this.onWindowMouseUp);
      return true;
    }
    this.marqueeActive = false;
    this.marqueeMoved = false;
    this.marqueeForStory = false;
    this.draggingSelection = false;
    this.selStart = null;
    this.selEnd = null;
    document.body.style.userSelect = '';
    window.removeEventListener('mousemove', this.onWindowMouseMove);
    window.removeEventListener('mouseup', this.onWindowMouseUp);
    return true;
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
      if (e - s <= EPS) continue;
      // Section [s,e] intersects the marquee [lo,hi] (endpoints-only touch excluded via EPS).
      if (s < hi - EPS && e > lo + EPS) hits.push({ lo: s, hi: e });
    }
    const merged = mergeRanges(hits);
    this.selectedRanges = merged.map(r => ({ start: r.lo, end: r.hi }));
    this.selStart = null;
    this.selEnd = null;
    this.selectedGroupStart = null;
    this.selectedGroupEnd = null;
  }

  // ── Timecode readout (HH:MM:SS:FF, NDF colons) ──────────────────────────────
  get timecode(): string {
    return formatTimecode(this.playheadTime, this.manifest?.frameSeconds || (1001 / 30000));
  }

  get sessionName(): string { return this.manifest?.session || ''; }

  // ── Scrub / drag on canvas ──────────────────────────────────────────────────
  onCanvasMouseDown(ev: MouseEvent): void {
    if (this.errorMessage || !this.manifest) return;
    ev.preventDefault();
    this.menuOpen = false;                 // a canvas interaction dismisses the File menu
    const t = this.canvasEventTime(ev);
    const y = this.canvasEventY(ev);
    const inRuler = y <= RULER_H;
    const inRibbon = this.hasStories() && y > RULER_H && y <= RULER_H + this.ribbonHeight;
    // Any fresh canvas gesture drops a prior story selection; the ribbon branch below re-sets it.
    this.storySelection = null;

    // A mousedown in the stories ribbon: grabbing a region EDGE (any tool) starts an edge drag
    // that redefines that boundary. Otherwise a click on a ribbon block SELECTS that story chunk
    // (the delete target) and makes its story active — in any tool.
    if (inRibbon) {
      // Right-click is the story menu's gesture, and contextmenu fires AFTER mousedown — running
      // the click logic first would clear the merge pick on the way to the menu, leaving Merge
      // grayed out on the very selection the user right-clicked. openStoryCtxMenu owns the pick
      // rules (keep it when clicking inside it, replace it when clicking outside).
      if (ev.button === 2) return;
      // ⌘-click on a story block picks it for merging instead of selecting a chunk — the same
      // gesture as in the story list, so a run of mis-split stories can be picked off the ribbon
      // where the split is actually visible. Checked before the edge grab so a ⌘-click near a
      // boundary picks rather than starting an edge drag.
      if (isMultiPick(ev)) {
        const hit = this.storyRegionAtEdited(t);
        if (hit) this.toggleStoryMerge(hit.storyId);   // re-renders the ribbon itself
        return;
      }
      this.clearStoryMergePick();
      const edgeHit = this.storyEdgeAtX(this.timeToX(t));
      if (edgeHit) {
        const story = this.stories.find(st => st.id === edgeHit.storyId);
        if (story) {
          // Canonicalize so the display-region index addresses story.regions directly.
          story.regions = mergeRegions(story.regions);
          this.draggingStoryEdge = edgeHit;
          window.addEventListener('mousemove', this.onWindowMouseMove);
          window.addEventListener('mouseup', this.onWindowMouseUp);
          this.requestRender();
          return;
        }
      }
      // A click on a ribbon block SELECTS that story chunk (region) — the target of a
      // chunk-delete — and makes its story active, highlighting just that region. Clicking a
      // gap in the ribbon (no block) leaves nothing selected.
      const chunk = this.storyRegionAtEdited(t);
      if (chunk) this.selectStoryChunk(chunk.storyId, chunk.regionIndex);
      this.requestRender();
      return;
    }
    this.clearStoryMergePick();   // any gesture outside the ribbon abandons the pick

    if (ev.shiftKey) {
      // Shift+drag paints a single free range (edited seconds) instead of scrubbing — a manual
      // range that replaces any marquee selection, so a group highlight no longer applies.
      this.selectedRanges = [];
      this.selStart = this.snapEdited(t, ev.altKey);
      this.selEnd = this.selStart;
      this.selectedGroupStart = null;
      this.selectedGroupEnd = null;
      this.draggingSelection = true;
      window.addEventListener('mousemove', this.onWindowMouseMove);
      window.addEventListener('mouseup', this.onWindowMouseUp);
      this.requestRender();
      return;
    }

    // A drag on the RULER always scrubs the playhead (either tool) — never a cut/marquee.
    if (inRuler) {
      this.draggingPlayhead = true;
      this.setPlayhead(t);
      window.addEventListener('mousemove', this.onWindowMouseMove);
      window.addEventListener('mouseup', this.onWindowMouseUp);
      this.requestRender();
      return;
    }

    // STORY MODE + Select tool: a drag in a track lane paints a region (committed on release
    // into the active story, or a new one). Reuses the marquee gesture, flagged so mouseup
    // routes it to a story rather than a cut selection. A bare click (no move) is a no-op.
    // With the BLADE tool active, story mode defers to the blade branch below — so the user
    // can pre-cut a section mid-clip and then paint stories against the new boundary.
    if (this.toolMode === 'story') {
      this.selectedRanges = [];
      this.selStart = null;
      this.selEnd = null;
      this.selectedGroupStart = null;
      this.selectedGroupEnd = null;
      this.marqueeActive = true;
      this.marqueeMoved = false;
      this.marqueeForStory = true;
      this.marqueeStartTime = this.snapEdited(t, false, Infinity);   // whole sections only
      this.marqueeEndTime = this.marqueeStartTime;
      window.addEventListener('mousemove', this.onWindowMouseMove);
      window.addEventListener('mouseup', this.onWindowMouseUp);
      this.requestRender();
      return;
    }

    const onClip = !!(this.rowAt(y) && this.segmentAt(this.rowAt(y)!.track.id, t));

    // SELECT tool, pointer INSIDE an existing highlight: this gesture is a MOVE of that footage,
    // not a new selection — so nothing is cleared or committed here. A drag past the promotion
    // threshold relocates on mouseup; a bare click falls through to the very same scrub + section
    // select it always did (deferred to mouseup, which is where we learn it was a click).
    // Gated on the lane rather than on a clip so the whole visible yellow band is grabbable,
    // including the lanes where the band crosses a gap.
    if (this.toolMode === 'select' && this.rowAt(y)) {
      const held = this.allSelectionRanges();
      if (held.some(r => t > r.lo + EPS && t < r.hi - EPS)) {
        this.moveDrag = {
          ranges: held,
          grabTime: t,
          dropAt: held[0].lo,          // no movement === no change
          boundaries: this.sectionBoundaries(),
          moved: false,
        };
        window.addEventListener('mousemove', this.onWindowMouseMove);
        window.addEventListener('mouseup', this.onWindowMouseUp);
        return;
      }
    }

    if (this.toolMode === 'select') {
      this.marqueeForStory = false;
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
      this.marqueeStartTime = this.snapEdited(t, ev.altKey);
      this.marqueeEndTime = this.marqueeStartTime;
      window.addEventListener('mousemove', this.onWindowMouseMove);
      window.addEventListener('mouseup', this.onWindowMouseUp);
      this.requestRender();
      return;
    }

    // BLADE tool. A cut is DROPPED only when the click lands directly on a clip in a track
    // lane; a click in empty timeline space just moves the playhead (no cut). Dropping a
    // blade is undoable (Cmd+Z).
    this.draggingPlayhead = true;
    this.setPlayhead(t);
    this.selectedRanges = [];
    if (onClip) {
      this.addBladeBoundary(this.editedToOriginal(t));
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
      if (b <= t + EPS) { if (lo === null || b > lo) lo = b; }
      if (b > t + EPS) { if (hi === null || b < hi) hi = b; }
    }
    if (lo === null || hi === null || hi - lo <= EPS) {
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
      if (e > EPS && e < this.editedDuration - EPS) out.push(e);
    }
    out.sort((a, b) => a - b);
    const dedup: number[] = [];
    for (const v of out) {
      if (dedup.length === 0 || v - dedup[dedup.length - 1] > EPS) dedup.push(v);
    }
    return dedup;
  }

  // ── Reordering: drag a selection to a new position ──────────────────────────
  /**
   * Live update of a selection-move drag. The insertion point is the pointer HARD-snapped to the
   * nearest section boundary, so a block can only ever land ON an edit — never mid-clip.
   */
  private updateMoveDrag(ev: MouseEvent): void {
    const d = this.moveDrag!;
    const t = this.canvasEventTime(ev);
    d.dropAt = nearestBoundary(d.boundaries, t);
    // Same 3px promotion threshold the marquee uses: a jittery click must never relocate footage.
    if (Math.abs(this.timeToX(t) - this.timeToX(d.grabTime)) > 3) d.moved = true;
    this.requestRender();
  }

  /**
   * The EDITED extent [start, end] of every sequence entry, parallel to sequenceSpans(). An
   * entry's surviving pieces are laid out consecutively by rebuildEditedModel (that is the whole
   * point of walking the sequence in playback order), so one pass over keptBySequence — which is
   * grouped by ascending `seq` for the same reason — fills the table. An entry the cuts emptied is
   * a ZERO-WIDTH point sitting at the write head, which is what lets it ride along with whichever
   * side of a nearby split it belongs to instead of vanishing from the walk.
   */
  private sequenceExtents(): { es: number; ee: number }[] {
    const seq = this.sequenceSpans();
    const out: { es: number; ee: number }[] = [];
    let acc = 0, k = 0;
    for (let s = 0; s < seq.length; s++) {
      const es = acc;
      while (k < this.keptBySequence.length && this.keptBySequence[k].seq === s) {
        acc = this.keptBySequence[k].ee;
        k++;
      }
      out.push({ es, ee: acc });
    }
    return out;
  }

  /**
   * Lift the current selection out of the playback sequence and re-insert it at `dropAt` (EDITED
   * seconds, already snapped to a section boundary), then rebuild.
   *
   * A multi-piece selection CONSOLIDATES into one contiguous block at the drop point, keeping the
   * pieces' order relative to each other; the gaps they left behind close up. Nothing else moves,
   * and no footage is added or removed — the sequence only ever gets re-ordered here, so the
   * result is a permutation of the same partition of [0, timelineDuration].
   *
   * The move is expressed entirely in ORIGINAL time on the sequence, never as "the original span
   * between the selection's two edges": after an earlier reorder, edited-adjacent footage can come
   * from anywhere, and that shortcut would drag along everything in between.
   */
  private moveSelectionTo(ranges: { lo: number; hi: number }[], dropAt: number): void {
    if (!this.manifest || ranges.length === 0) return;
    const seq = this.sequenceSpans();
    const ext = this.sequenceExtents();

    // Every edited time the sequence must be cut at: each selection edge (so a partly-covered
    // entry splits into a moved half and a staying half) plus the drop point itself (a snapped
    // clip edge is usually INTERIOR to an entry — with no sequence yet, every drop is).
    const splitTimes = [...ranges.flatMap(r => [r.lo, r.hi]), dropAt].sort((a, b) => a - b);

    const stay: { start: number; end: number }[] = [];
    const moved: { start: number; end: number }[] = [];
    let insertIdx = -1;
    for (let s = 0; s < seq.length; s++) {
      const { es, ee } = ext[s];
      // Interior split points, mapped back to ORIGINAL time. Both lists stay in lockstep: edges[j]
      // is the original start of sub-entry j, editedEdges[j] its edited start.
      const edges: number[] = [seq[s].start];
      const editedEdges: number[] = [es];
      for (const e of splitTimes) {
        if (e <= es + EPS || e >= ee - EPS) continue;
        const o = this.editedToOriginal(e);
        if (o > edges[edges.length - 1] + EPS && o < seq[s].end - EPS) {
          edges.push(o);
          editedEdges.push(e);
        }
      }
      edges.push(seq[s].end);

      for (let j = 0; j < edges.length - 1; j++) {
        const pieceEs = editedEdges[j];
        const pieceEe = (j + 1 < editedEdges.length) ? editedEdges[j + 1] : ee;
        // A sub-entry moves when its EDITED span lies inside a selected range. A zero-width one
        // (entirely cut) has no midpoint to test, so it moves only when strictly enclosed —
        // otherwise removed footage parked on the selection's edge would follow the block and
        // undoing the cut would resurrect it in the wrong place.
        const wide = pieceEe - pieceEs > EPS;
        const probe = wide ? (pieceEs + pieceEe) / 2 : pieceEs;
        const isMoved = wide
          ? ranges.some(r => probe > r.lo && probe < r.hi)
          : ranges.some(r => probe > r.lo + EPS && probe < r.hi - EPS);
        if (isMoved) { moved.push({ start: edges[j], end: edges[j + 1] }); continue; }
        // The block lands before the first STAYING sub-entry at or after the drop — computed
        // against the post-removal list, so a drop inside the selection is a no-op instead of an
        // off-by-the-selection's-length jump.
        if (insertIdx < 0 && pieceEs >= dropAt - EPS) insertIdx = stay.length;
        stay.push({ start: edges[j], end: edges[j + 1] });
      }
    }
    if (moved.length === 0) return;
    if (insertIdx < 0) insertIdx = stay.length;      // dropped past the last surviving entry

    this.pushUndo();
    this.redoStack = [];
    this.sequence = normalizeSequence([
      ...stay.slice(0, insertIdx), ...moved, ...stay.slice(insertIdx),
    ], this.manifest?.timelineDuration || 0);
    this.rebuildEditedModel();

    // Re-select the block where it now lives: the user just placed it, and losing the highlight
    // would make a follow-up nudge impossible without re-marqueeing.
    const landed = mergeRanges(
      moved.flatMap(p => this.editedRangesForOriginal(p.start, p.end)));
    this.selStart = null;
    this.selEnd = null;
    this.selectedGroupStart = null;
    this.selectedGroupEnd = null;
    this.storySelection = null;
    this.selectedRanges = landed.map(r => ({ start: r.lo, end: r.hi }));
    // Story numbers are a display/export ordering only — after a move they must follow the footage.
    this.renumberStoriesByTimeline();
    this.landPlayheadAfterEdit(landed.length > 0 ? landed[0].lo : this.playheadTime, true);
  }

  /** Add a blade boundary (ORIGINAL seconds), sorted + de-duplicated. Undoable (Cmd+Z). */
  private addBladeBoundary(originalSec: number): void {
    const t = Math.min(this.manifest?.timelineDuration || 0, Math.max(0, originalSec));
    for (const b of this.bladeBoundaries) {
      if (Math.abs(b - t) <= EPS) return; // already present — no-op, no undo entry
    }
    // A dropped blade is an undoable edit: snapshot first, clear redo, then add immutably
    // (so the snapshot's blade array is not mutated underneath it).
    this.pushUndo();
    this.redoStack = [];
    this.bladeBoundaries = [...this.bladeBoundaries, t].sort((a, b) => a - b);
    this.scheduleEditsSave();
    this.requestRender();
  }

  /** Drop blade boundaries that a cut has swallowed (their original time now inside a cut). */
  private pruneBladeBoundaries(): void {
    if (this.bladeBoundaries.length === 0) return;
    const fs = this.manifest?.frameSeconds;
    if (!fs) return;
    this.bladeBoundaries = this.bladeBoundaries.filter(b => {
      for (const c of this.cuts) {
        if (b > c.startFrame * fs + EPS && b < c.endFrame * fs - EPS) return false;
      }
      return true;
    });
  }

  /** Switch the active pointer tool (Arrow / Blade / Story). Entering Story shows the Stories
   *  tab (the tab binds to the derived `storyMode`); leaving it drops the active paint target
   *  and any story selection. */
  setTool(mode: ToolMode): void {
    if (this.toolMode === mode) return;
    if (this.toolMode === 'story' && mode !== 'story') {
      this.activeStoryId = null;
      this.storySelection = null;
    }
    this.toolMode = mode;
    this.requestRender();
  }

  private onWindowMouseMove = (ev: MouseEvent): void => {
    if (this.draggingStoryEdge) { this.updateStoryEdgeDrag(ev); }
    else if (this.moveDrag) { this.updateMoveDrag(ev); }
    else if (this.draggingSelection) { this.selEnd = this.snapEdited(this.canvasEventTime(ev), ev.altKey); this.requestRender(); }
    else if (this.marqueeActive) {
      this.marqueeEndTime = this.marqueeForStory
        ? this.snapEdited(this.canvasEventTime(ev), false, Infinity)   // whole sections only
        : this.snapEdited(this.canvasEventTime(ev), ev.altKey);
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
        && !this.marqueeActive && !this.draggingStoryEdge && !this.moveDrag) return;
    // Persist split preferences once per drag (not per move frame).
    if (this.draggingSplitV) localStorage.setItem(this.SPLIT_V_KEY, String(this.splitV));
    if (this.draggingSplitH) localStorage.setItem(this.SPLIT_H_KEY, String(this.splitH));
    if (this.draggingSplitP) localStorage.setItem(this.SPLIT_P_KEY, String(Math.round(this.projectWidth)));
    // Dropping a story-edge drag re-merges the story's regions (the dragged edge may have
    // crossed a sibling region of the same story).
    if (this.draggingStoryEdge) {
      const story = this.stories.find(s => s.id === this.draggingStoryEdge!.storyId);
      if (story) story.regions = mergeRegions(story.regions);
      this.draggingStoryEdge = null;
      this.scheduleEditsSave();
    }
    // A selection-move drag that actually moved relocates the footage; one that never passed the
    // threshold was a click inside the highlight, which must still scrub + select its section.
    if (this.moveDrag) {
      const d = this.moveDrag;
      this.moveDrag = null;
      if (d.moved) {
        // The FROZEN ranges, not the live selection: what commits must be exactly what the ghost
        // promised for the whole drag.
        this.moveSelectionTo(d.ranges, d.dropAt);
      } else {
        this.setPlayhead(d.grabTime);
        this.selectedRanges = [];
        this.selectSectionAround(d.grabTime);
      }
    }
    // A marquee that actually moved commits its section selection; a bare click leaves the
    // section-select outcome from mousedown untouched.
    if (this.marqueeActive) {
      if (this.marqueeForStory) {
        // A moved Story-Mode drag paints a region; a bare click is a no-op.
        if (this.marqueeMoved) {
          const lo = Math.min(this.marqueeStartTime, this.marqueeEndTime);
          const hi = Math.max(this.marqueeStartTime, this.marqueeEndTime);
          this.paintStoryRegion(this.editedToOriginal(lo), this.editedToOriginal(hi));
        }
      } else if (this.marqueeMoved) {
        this.commitMarquee();
      }
      this.marqueeActive = false;
      this.marqueeMoved = false;
      this.marqueeForStory = false;
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
    this.updateActiveGroup(true);   // keep the transcript highlight under the playhead
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
  /**
   * Zoom slider position (0..1000) mapped LOGARITHMICALLY between minZoom (whole timeline
   * fits) and ZOOM_MAX — a linear px/s slider would waste almost the whole track on the
   * useless far-in end for a 4-hour session.
   */
  get zoomSliderPos(): number {
    const lo = this.minZoom, hi = ZOOM_MAX;
    if (!(hi > lo)) return 1000;
    const p = Math.log(this.pxPerSec / lo) / Math.log(hi / lo);
    return Math.round(1000 * Math.min(1, Math.max(0, p)));
  }

  onZoomSlider(value: number): void {
    // Slider zooms about the playhead (keeps it fixed on screen).
    const lo = this.minZoom, hi = ZOOM_MAX;
    const pps = hi > lo ? lo * Math.pow(hi / lo, Number(value) / 1000) : hi;
    const anchorX = this.timeToX(this.playheadTime);
    this.setZoom(pps, this.playheadTime, anchorX);
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
    if (ev.key === 'Escape' && (this.menuOpen || this.exportChooserOpen || this.exportResultPath || this.exportError)) {
      ev.preventDefault();
      this.menuOpen = false;
      this.exportChooserOpen = false;
      this.closeExportModal();
      return;
    }
    // Ignore every editor shortcut while the user is typing (e.g. the transcript search
    // box) — space, A/B, I/O, Delete, Cmd+X, Cmd+E must reach the input, not the timeline.
    if (isTypingTarget(ev.target)) return;
    if (ev.key === ' ' || ev.code === 'Space') {
      ev.preventDefault();
      this.togglePlayback();
    } else if (ev.key === 'k' || ev.key === 'K') {
      ev.preventDefault();
      this.togglePlayback();          // K: play/pause (resets speed on pause)
    } else if (ev.key === 'l' || ev.key === 'L') {
      ev.preventDefault();
      this.cycleSpeedUp();            // L: faster (1.5→2→2.5→3)
    } else if (ev.key === 'j' || ev.key === 'J') {
      ev.preventDefault();
      this.cycleSpeedDown();         // J: slower (0.75→0.66→0.5→0.25)
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
      // Cmd/Ctrl+E opens the Export chooser (no-op while loading or with nothing to export).
      ev.preventDefault();
      if (this.loading) return;
      this.openExportChooser();
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
    } else if ((ev.key === 's' || ev.key === 'S') && !ev.metaKey && !ev.ctrlKey) {
      // S: switch to the Story tool (like A=Select, B=Blade). A/B leave it.
      if (this.loading) return;
      ev.preventDefault();
      this.setTool('story');
    } else if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'x' || ev.key === 'X')) {
      // Cmd/Ctrl+X: a selected story chunk/story is removed from the story list; otherwise it's
      // the FCP ripple-delete alias for the timeline selection.
      if (this.loading) return;
      ev.preventDefault();
      if (this.storySelection) { this.deleteStorySelection(); return; }
      this.deleteSelection();
    } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
      if (this.loading) return;
      ev.preventDefault();
      if (this.storySelection) { this.deleteStorySelection(); return; }
      this.deleteSelection();
    } else if (ev.key === 'Escape') {
      if (this.loading) return;
      ev.preventDefault();
      // A highlight in progress? Cancel it (throw away an accidental marquee) before anything
      // else. Otherwise clear the timeline selection + transcript highlight + story selection.
      if (this.abortInFlightGesture()) { this.requestRender(); return; }
      this.clearSelection();
      this.requestRender();
    }
  }

  // ── Selection + cut editing ─────────────────────────────────────────────────
  /** Normalized selection [lo, hi] in EDITED seconds, or null when absent/one-sided/empty. */
  private selRange(): { lo: number; hi: number } | null {
    if (this.selStart == null || this.selEnd == null) return null;
    const lo = Math.min(this.selStart, this.selEnd);
    const hi = Math.max(this.selStart, this.selEnd);
    if (hi - lo <= EPS) return null;
    return { lo, hi };
  }

  /**
   * The undoable edit state, copied — every one of these arrays is replaced or rebuilt in place
   * elsewhere, and a snapshot aliasing them would mutate under the stack.
   *
   * The SEQUENCE has to ride along with the cuts: the two are read together by
   * rebuildEditedModel, so undoing to a cut list from before a reorder while leaving the new
   * order in place would re-tile the restored footage into the wrong slots.
   */
  private editSnapshot(): EditSnapshot {
    return {
      cuts: [...this.cuts],
      blades: [...this.bladeBoundaries],
      sequence: this.sequence ? this.sequence.map(s => ({ start: s.start, end: s.end })) : null,
    };
  }

  /** Restore a snapshot onto the live state (the caller rebuilds the model). */
  private applyEditSnapshot(s: EditSnapshot): void {
    this.cuts = s.cuts;
    this.bladeBoundaries = s.blades;
    // Snapshots persisted before reordering existed carry no `sequence`; undefined must read as
    // SOURCE ORDER, not as an empty sequence — sequenceSpans() would then tile nothing and the
    // undo would blank the whole timeline.
    this.sequence = s.sequence ?? null;
  }

  private pushUndo(): void {
    this.undoStack.push(this.editSnapshot());
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
      // One edited range can cover SEVERAL original spans once footage has been reordered.
      // Mapping only its two edges would cut everything lying between them in original time —
      // footage the user never highlighted. In source order this yields the single span the two
      // edges always described.
      for (const span of this.originalSpansForEdited(r.lo, r.hi)) {
        const startFrame = Math.round(span.start / fs);
        const endFrame = Math.round(span.end / fs);
        if (endFrame <= startFrame) continue;   // sub-frame span — nothing to remove
        newCuts.push({ startFrame, endFrame });
        if (firstStartFrame === null || startFrame < firstStartFrame) firstStartFrame = startFrame;
      }
    }
    if (newCuts.length === 0) {
      // Every range rounded to zero frames. Clear and bail without touching history.
      this.clearSelection();
      this.requestRender();
      return;
    }
    this.pushUndo();
    this.redoStack = [];
    this.cuts = mergeCuts([...this.cuts, ...newCuts]);
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
    this.redoStack.push(this.editSnapshot());
    this.applyEditSnapshot(this.undoStack.pop()!);
    this.rebuildEditedModel();
    this.clearSelection();
    this.landPlayheadAfterEdit(this.originalToEdited(origTime), false);
  }

  private redo(): void {
    if (this.redoStack.length === 0) return;
    const origTime = this.editedToOriginal(this.playheadTime);
    this.undoStack.push(this.editSnapshot());
    this.applyEditSnapshot(this.redoStack.pop()!);
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
    return `${m}:${pad2(s)}`;
  }

  // ── Edit-state persistence ───────────────────────────────────────────────────
  /**
   * Restore edit state from the sidecar. Validates loudly: a sidecar with the wrong
   * schema or a non-array field names exactly what is wrong rather than half-loading.
   */
  private restoreEdits(e: any): void {
    if (e.schemaVersion !== EditorComponent.EDITS_SCHEMA_VERSION) {
      throw new Error(`edit-state sidecar has schemaVersion ${e.schemaVersion}; ` +
        `this build reads version ${EditorComponent.EDITS_SCHEMA_VERSION}`);
    }
    for (const key of ['cuts', 'bladeBoundaries', 'stories', 'undoStack', 'redoStack'] as const) {
      if (!Array.isArray(e[key])) {
        throw new Error(`edit-state sidecar field '${key}' is not an array — fix or delete the file`);
      }
    }
    // `sequence` is OPTIONAL and its ABSENCE means source order — which is exactly what every
    // sidecar written before reordering existed contains. That is why this did NOT bump
    // EDITS_SCHEMA_VERSION: the check above rejects a mismatch outright ("fix or delete the
    // file"), so a bump would orphan every project on disk. An added optional field is
    // compatible in both directions instead.
    if (e.sequence !== undefined && e.sequence !== null) {
      if (!Array.isArray(e.sequence)) {
        throw new Error(`edit-state sidecar field 'sequence' is not an array — fix or delete the file`);
      }
      for (const s of e.sequence) {
        if (!s || typeof s.start !== 'number' || typeof s.end !== 'number' || !(s.end > s.start)) {
          throw new Error(`edit-state sidecar has a malformed 'sequence' entry — fix or delete the file`);
        }
      }
      // The sequence must TILE [0, timelineDuration] exactly. A gap would silently hide footage
      // that the cut list says survives, and an overlap would play it twice — either way the
      // timeline would stop matching the export, so refuse the file instead of guessing.
      const dur = this.manifest?.timelineDuration || 0;
      const tiled = [...e.sequence].sort((a: any, b: any) => a.start - b.start);
      const TOL = 1e-6;
      let ok = Math.abs(tiled[0].start) <= TOL && Math.abs(tiled[tiled.length - 1].end - dur) <= TOL;
      for (let i = 1; ok && i < tiled.length; i++) ok = Math.abs(tiled[i].start - tiled[i - 1].end) <= TOL;
      if (!ok) {
        throw new Error(`edit-state sidecar 'sequence' does not tile [0, ${dur}] — fix or delete the file`);
      }
    }
    // Optional like `sequence` (and for the same schema-version reasoning): absence means
    // the default, mute armed. Only `false` is ever written.
    if (e.muteMicDuringScreen !== undefined && typeof e.muteMicDuringScreen !== 'boolean') {
      throw new Error(`edit-state sidecar field 'muteMicDuringScreen' is not a boolean — fix or delete the file`);
    }
    this.suppressEditsSave = true;
    try {
      this.cuts = e.cuts;
      this.muteMicDuringScreen = e.muteMicDuringScreen !== false;
      this.bladeBoundaries = e.bladeBoundaries;
      this.sequence = (Array.isArray(e.sequence) && e.sequence.length > 0) ? e.sequence : null;
      this.stories = e.stories;
      this.storyIdCounter = Number.isInteger(e.storyIdCounter) ? e.storyIdCounter : this.stories.length;
      this.undoStack = e.undoStack;
      this.redoStack = e.redoStack;
      this.rebuildEditedModel();
    } finally {
      this.suppressEditsSave = false;
    }
    this.requestRender();
  }

  /** Debounced save of the edit-state sidecar. Call after EVERY edit mutation. */
  private scheduleEditsSave(): void {
    if (this.suppressEditsSave || this.loading || !this.currentZipPath) return;
    if (this.editsSaveTimer !== null) clearTimeout(this.editsSaveTimer);
    this.editsSaveTimer = setTimeout(() => {
      this.editsSaveTimer = null;
      const zipPath = this.currentZipPath;
      if (!zipPath) return;
      const edits = {
        schemaVersion: EditorComponent.EDITS_SCHEMA_VERSION,
        session: this.sessionName,
        savedAt: new Date().toISOString(),
        cuts: this.cuts,
        bladeBoundaries: this.bladeBoundaries,
        // Written ONLY when the user has actually reordered something, so an untouched project's
        // sidecar stays byte-identical to what older builds produce and read.
        ...(this.sequence ? { sequence: this.sequence } : {}),
        // Same rule: only the NON-default (off) is written. Absent means "mute armed", which
        // is what every sidecar written before this switch existed already says by saying
        // nothing.
        ...(this.muteMicDuringScreen ? {} : { muteMicDuringScreen: false }),
        stories: this.stories,
        storyIdCounter: this.storyIdCounter,
        undoStack: this.undoStack,
        redoStack: this.redoStack,
      };
      this.electron.saveEditorEdits({ zipPath, edits }).catch((err: any) => {
        // Surface, don't swallow: a failing save means edits are NOT persisting.
        this.transportError = `Failed to save edits: ${err?.message || err}`;
        this.cdr.detectChanges();
      });
    }, 800);
  }

  /** True when Export has something to do: at least one cut OR at least one marked story. */
  canExport(): boolean {
    return !this.exporting && !!this.currentZipPath && (this.cuts.length > 0 || this.hasStories());
  }

  /** File ▸ Export… / ⌘E: open the chooser modal (Master FCPXML vs Stories). */
  openExportChooser(): void {
    if (!this.canExport()) return;
    this.menuOpen = false;
    this.exportChooserOpen = true;
  }

  /**
   * True when the mic-mute option can be offered at all. The mute blocks are derived from
   * the Whisper transcript sidecar's word times, so without a ready transcript there is
   * nothing to derive them FROM — and Python refuses the export rather than exporting
   * without the muting. Better to grey the checkbox than to hand the user that failure.
   */
  canMuteMicDuringScreen(): boolean {
    return this.transcriptState === 'ready';
  }

  /**
   * Top-bar master switch for the mic-mute pass. One state shared with the export-chooser
   * checkbox; persisted in the edits sidecar so an "off" choice survives reopening the
   * session (absent from the sidecar = the default, on).
   */
  toggleMuteMicDuringScreen(): void {
    this.muteMicDuringScreen = !this.muteMicDuringScreen;
    this.scheduleEditsSave();
  }

  /** Chooser modal choice → run that export. */
  onExportChoice(kind: 'fcpxml' | 'transcripts'): void {
    this.exportChooserOpen = false;
    void this.onExport(kind);
  }

  /**
   * Export via Python. 'fcpxml' writes the master FCPXML: with stories marked it splits into
   * one <project> per story plus a Scrap project of unmarked sections (cuts applied); with
   * none it applies the cuts to the existing part projects. 'transcripts' writes ONLY the
   * per-story Content Studio transcript files.
   */
  async onExport(kind: 'fcpxml' | 'transcripts'): Promise<void> {
    if (this.exporting || !this.currentZipPath) return;
    if (kind === 'fcpxml' && this.cuts.length === 0 && !this.hasStories()) return;
    if (kind === 'transcripts' && !this.hasStories()) return;
    this.exporting = true;
    this.exportError = null;
    this.exportResultPath = null;
    this.exportMicMuteBlocks = null;
    this.cdr.detectChanges();
    try {
      const stories = this.hasStories() ? this.resolveStoryRegions() : undefined;
      const res = await this.electron.exportEditorCuts({
        zipPath: this.currentZipPath!, cuts: this.cuts,
        sequence: this.exportSequence(),
        stories, output: stories ? kind : undefined,
        // Sent explicitly on BOTH the plain-cuts and the story FCPXML paths (the
        // transcripts-only export writes no FCPXML, so Python ignores it there). Gated on
        // the transcript being ready, because the flag has no signal to work from without
        // one and Python would — correctly — refuse the whole export.
        muteMicDuringScreen: this.canMuteMicDuringScreen() && this.muteMicDuringScreen,
      });
      const path = res?.path;
      if (!path) throw new Error(res?.message || 'Export did not return an output path.');
      this.exportResultPath = path;
      // Present only when the mute pass ran. Zero is a real count and must not be coerced
      // away — the typeof check keeps 0 while turning an absent field into "did not run".
      this.exportMicMuteBlocks = typeof res?.micMuteBlocks === 'number' ? res.micMuteBlocks : null;
    } catch (err: any) {
      // Python's message is authoritative — show it verbatim.
      this.exportError = err?.message || String(err);
    } finally {
      this.exporting = false;
      this.menuOpen = false;   // the result now shows in the modal, not the menu
      this.cdr.detectChanges();
    }
  }

  /**
   * The playback order as the EXPORT WIRE FORMAT — which is deliberately NOT the in-memory model,
   * and this is the single most confusable thing in the reorder feature:
   *
   *   in memory  `sequence` partitions SLOTS over the whole original timeline [0, timelineDuration],
   *              cut material included. That is what keeps cuts purely subtractive and lets an
   *              undone cut land back in the slot it was lifted from.
   *   on the wire the exporter requires a partition of the SURVIVORS — the complement of the cuts —
   *              in playback order, and its validator refuses anything else. Sending the slots gets
   *              "sequence must partition the footage the cuts leave behind" for every project that
   *              has BOTH a cut and a move. (0–10s, cut 3–4, one move: slots `[{4,10},{0,4}]` is
   *              rejected; survivors `[{4,10},{0,3}]` is accepted.)
   *
   * keptBySequence IS that survivor list already — the spans the sequence carved out of the cut
   * complement, ordered by `es` — so all that is left is to frame-align it (the exporter checks
   * alignment to 1e-6 s, and these bounds reach us through editedToOriginal and the cut math, so
   * they are exactly where drift would show up) and to re-join spans that are BOTH source-adjacent
   * and playback-consecutive, which would otherwise ask the exporter for a division the user never
   * made. Undefined in source order — absent means source order on both sides, which is what keeps
   * every existing project exporting exactly as it does today.
   */
  private exportSequence(): { start: number; end: number }[] | undefined {
    if (!this.sequence || !this.manifest) return undefined;
    const fs = this.manifest.frameSeconds;
    const out: { start: number; end: number }[] = [];
    for (const k of this.keptBySequence) {
      // Both sides of an interior split quantize from the same number, so alignment can never open
      // a gap or an overlap between neighbours. Math.round is monotonic, so a span can never invert.
      const start = Math.round(k.os / fs) * fs;
      const end = Math.round(k.oe / fs) * fs;
      if (end - start <= EPS) continue;      // collapsed to nothing by alignment
      const last = out[out.length - 1];
      if (last && Math.abs(last.end - start) <= EPS) last.end = end;
      else out.push({ start, end });
    }
    return out.length > 0 ? out : undefined;
  }

  /** Reveal the exported file in Finder/Explorer. */
  onShowExport(): void {
    if (this.exportResultPath) void this.electron.showInFolder(this.exportResultPath);
  }

  /** Dismiss the export result/error modal. */
  closeExportModal(): void {
    this.exportResultPath = null;
    this.exportError = null;
    this.exportMicMuteBlocks = null;
  }

  // ── Stories (mark / name / number spans) ─────────────────────────────────────
  /** True when any story is marked (drives the ribbon's visibility + height). PUBLIC — the
   *  export wiring will consult it in a later change. */
  hasStories(): boolean {
    return this.stories.length > 0;
  }

  /**
   * The SINGLE source of truth for both the ribbon and (later) the export: resolve each
   * story's EFFECTIVE regions under last-writer-wins nesting. PURE — reads only `stories`,
   * mutates nothing. For story i (creation order) its regions = its [start,end] MINUS the
   * union of every LATER story j>i (exact interval subtraction, ORIGINAL float seconds — the
   * export re-quantizes to frames). A story wholly painted over yields zero regions (still
   * listed, empty). The returned list is ordered by `number` ascending (export/project order;
   * ties broken by creation order for stability); each story's regions are sorted ascending.
   * PUBLIC — the export wiring will call it later.
   */
  resolveStoryRegions(): { number: number; title: string; regions: { start: number; end: number }[] }[] {
    return storiesForDisplay(this.stories).map(({ number, title, regions }) => ({ number, title, regions }));
  }

  // Template-callable delegates for the pure helpers in model/story-utils.ts. strictTemplates
  // cannot call an imported function, so the shell keeps a one-line method for each name the
  // .html reads. The doc comments live with the implementations.
  /** True when a story has no regions (nothing to export). */
  isStoryEmpty(story: Story): boolean {
    return isStoryEmpty(story);
  }

  /** Where a story's chapters stand against its regions RIGHT NOW ('fresh' | 'stale' | 'none'). */
  storyChapterState(story: Story): 'fresh' | 'stale' | 'none' {
    return storyChapterState(story);
  }

  /** How many of a story's chapter starts are ±45 s guesses rather than mapped quotes. */
  storyApproxChapters(story: Story): number {
    return storyApproxChapters(story);
  }

  /** Stable, distinct color for a story NUMBER (palette cycled; safe for any integer). */
  storyColor(n: number): string {
    return storyColor(n);
  }


  /** Story Mode is derived from the tool: it's ON exactly when the Story tool is active. Drives
   *  the Edit/Stories tab highlight, the stories pane, and the paint gesture. */
  get storyMode(): boolean {
    return this.toolMode === 'story';
  }

  /** Enter/leave Story Mode by switching the tool (the left-pane tabs land here). */
  setStoryMode(on: boolean): void {
    this.setTool(on ? 'story' : 'select');
  }

  toggleStoryMode(): void {
    this.setTool(this.storyMode ? 'select' : 'story');
  }

  /** Re-assign story numbers to 1..N in array order so project numbering is always sequential:
   *  deleting a story shifts its successors down, and the color notch (cycled by number) tracks
   *  it. Numbers are no longer user-editable — they simply reflect order. */
  private renumberStories(): void {
    this.stories.forEach((s, i) => { s.number = i + 1; });
  }

  /**
   * Re-sort the story list by where each story's footage now SITS on the edited timeline, then
   * renumber. A story number is a display/export ordering convenience, never data: after footage
   * moves, the list, the ribbon colors and the exported project order all have to follow the
   * timeline rather than a number someone typed earlier. Stories with nothing left (fully cut)
   * keep their relative order at the end, where an empty story belongs.
   */
  private renumberStoriesByTimeline(): void {
    if (this.stories.length === 0) return;
    const keyOf = (s: Story): number => {
      let best = Infinity;
      for (const r of mergeRegions(s.regions)) {
        const pieces = this.editedRangesForOriginal(r.start, r.end);
        if (pieces.length > 0 && pieces[0].lo < best) best = pieces[0].lo;
      }
      return best;
    };
    const keyed = this.stories.map((s, i) => ({ s, i, k: keyOf(s) }));
    // Infinity - Infinity is NaN, which corrupts a comparator — compare, don't subtract.
    keyed.sort((a, b) => (a.k === b.k ? 0 : (a.k < b.k ? -1 : 1)) || (a.i - b.i));
    this.stories = keyed.map(x => x.s);
    this.renumberStories();
  }

  /**
   * Select/deselect a story as the ACTIVE paint target. Clicking the active story again
   * deselects it (so the next drag starts a fresh story). Only meaningful in Story Mode.
   */
  toggleActiveStory(id: string): void {
    this.activeStoryId = this.activeStoryId === id ? null : id;
    this.requestRender();
  }

  /** Strip-row click: select the row's story active, unless the click was on an input/button. */
  /**
   * ⌘-picking is handled on MOUSEDOWN, not click, and at the ROW level.
   *
   * Three parts of a row swallow a click before it can reach the row handler: the title <input>
   * (flex:1, so it covers most of the row's width, and the click handler must skip it to let the
   * field take focus), the colour swatch, and the number — the last two stopPropagation for their
   * own gestures. Handling the modifier click at the row's mousedown reaches all three, and
   * preventDefault() stops the title field stealing focus on the way.
   */
  onStoryRowMouseDown(story: Story, ev: MouseEvent): void {
    if (!isMultiPick(ev)) {
      // A plain press clears any stale suppression from a press that never produced a click
      // (mousedown here, mouseup elsewhere) — otherwise it would eat the NEXT ordinary click.
      this.suppressStoryClick = false;
      return;
    }
    ev.preventDefault();
    this.suppressStoryClick = true;
    this.toggleStoryMerge(story.id);
  }

  /** True once, when the click that follows a ⌘-pick mousedown should be ignored. */
  private suppressStoryClick = false;
  private consumeStoryClickSuppression(): boolean {
    if (!this.suppressStoryClick) return false;
    this.suppressStoryClick = false;
    return true;
  }

  onStoryRowClick(story: Story, ev: Event): void {
    if (this.consumeStoryClickSuppression()) return;   // the ⌘-pick already happened on mousedown
    const tag = (ev.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'BUTTON') return;   // let field/delete handle their own click
    this.clearStoryMergePick();                        // a plain click abandons a half-made pick
    this.toggleActiveStory(story.id);
  }

  /** Swatch click — selects the whole story, unless this click is the tail of a ⌘-pick. */
  onStorySwatchClick(story: Story, ev: MouseEvent): void {
    ev.stopPropagation();
    if (this.consumeStoryClickSuppression()) return;
    this.selectWholeStory(story);
  }

  /** The number is the drag handle; a plain click on it does nothing but must not reach the row. */
  onStoryNumClick(ev: MouseEvent): void {
    ev.stopPropagation();
    this.consumeStoryClickSuppression();
  }

  /**
   * Paint one region [startOrig, endOrig] (ORIGINAL seconds) into a story. With a story active
   * the region is appended to it (regions re-merged); with none active a brand-new story is
   * created — deliberately NOT auto-activated, so consecutive drags make separate stories and
   * the user accumulates regions by first selecting a story. Off the cut undo stack.
   */
  private paintStoryRegion(startOrig: number, endOrig: number): void {
    const lo = Math.min(startOrig, endOrig);
    const hi = Math.max(startOrig, endOrig);
    if (!(hi - lo > EPS)) return;

    const active = this.activeStoryId ? this.stories.find(s => s.id === this.activeStoryId) : null;
    if (active) {
      active.regions = mergeRegions([...active.regions, { start: lo, end: hi }]);
    } else {
      const number = this.stories.length + 1;
      const story: Story = {
        id: `story-${++this.storyIdCounter}`,
        number,
        title: `Story ${number}`,
        regions: [{ start: lo, end: hi }],
      };
      this.stories = [...this.stories, story];
      this.renumberStories();
    }
    this.scheduleEditsSave();
    this.requestRender();
    this.cdr.detectChanges();
  }

  /** Inline title edit (immediate). Redraws so the ribbon label tracks the new title. */
  onStoryTitleInput(story: Story, value: string): void {
    story.title = value;
    // Typed by hand ⇒ auto-titling must never overwrite it. Set even when the field is cleared:
    // an empty title the user emptied on purpose is still a decision, and re-filling it from a
    // model would look like the app disagreeing with them.
    story.titleTouched = true;
    this.scheduleEditsSave();
    this.requestRender();
  }

  /** Color-notch click: select the WHOLE story (all its regions) and make it the active paint
   *  target. A follow-up Delete removes the whole story (× does the same); it never ripples the
   *  timeline. */
  selectWholeStory(story: Story): void {
    this.storySelection = { storyId: story.id, regionIndex: null };
    this.activeStoryId = story.id;
    this.selectResolvedStory({ regions: mergeRegions(story.regions) });
    this.requestRender();
  }

  /** Select one story CHUNK (region) as the delete target and make its story active. The story's
   *  regions are canonicalized (merged) so `regionIndex` addresses story.regions directly, and
   *  only that region is reflected into the timeline highlight. */
  selectStoryChunk(storyId: string, regionIndex: number): void {
    const story = this.stories.find(s => s.id === storyId);
    if (!story) return;
    story.regions = mergeRegions(story.regions);
    this.storySelection = { storyId, regionIndex };
    this.activeStoryId = storyId;
    const region = story.regions[regionIndex];
    this.selectResolvedStory({ regions: region ? [region] : [] });
    this.requestRender();
  }

  /** Delete the current story selection WITHOUT touching the timeline: a chunk selection removes
   *  just that region (the story survives even if it empties — use × to remove it entirely); a
   *  whole-story selection removes the story. */
  private deleteStorySelection(): void {
    const sel = this.storySelection;
    if (!sel) return;
    const story = this.stories.find(s => s.id === sel.storyId);
    if (!story) { this.storySelection = null; return; }
    if (sel.regionIndex === null) {
      this.deleteStory(story);
      return;
    }
    story.regions = mergeRegions(story.regions);
    if (sel.regionIndex >= 0 && sel.regionIndex < story.regions.length) {
      story.regions.splice(sel.regionIndex, 1);
    }
    this.storySelection = null;
    this.clearSelection();
    this.scheduleEditsSave();
    this.requestRender();
    this.cdr.detectChanges();
  }

  // ── Merging stories ─────────────────────────────────────────────────────────
  /** Add/remove a story from the merge pick. */
  toggleStoryMerge(id: string): void {
    if (this.storyMergeIds.has(id)) this.storyMergeIds.delete(id);
    else this.storyMergeIds.add(id);
    this.requestRender();          // the ribbon outlines picked stories too
    this.cdr.detectChanges();
  }

  // ── Reordering stories (drag) ───────────────────────────────────────────────
  // Story order IS the export order: editor_export.py emits one <project> per story into the
  // event, `projects.sort(key=number)`, Scrap last. So dragging a story to a new slot literally
  // reorders the <project> elements in the FCPXML — the content moves with the story.
  //
  // The drag handle is the story NUMBER, not the whole row: the row holds an inline <input> for
  // the title, and a draggable row would fight text selection inside it.
  dragStoryId: string | null = null;
  /** Insertion point while dragging: drop BEFORE this story, or null for the end of the list. */
  dropBeforeId: string | null = null;

  onStoryDragStart(story: Story, ev: DragEvent): void {
    this.dragStoryId = story.id;
    this.dropBeforeId = null;
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', story.id);   // Firefox needs data set to start a drag
    }
  }

  onStoryDragOver(story: Story, ev: DragEvent): void {
    if (!this.dragStoryId) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    // Above the row's midpoint drops before it; below drops before the NEXT one (i.e. after this).
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const idx = this.stories.findIndex(s => s.id === story.id);
    const target = ev.clientY < rect.top + rect.height / 2
      ? story.id
      : (this.stories[idx + 1]?.id ?? null);
    if (this.dropBeforeId !== target) {
      this.dropBeforeId = target;
      this.cdr.detectChanges();
    }
  }

  /** Dragging over the pane below the last row targets the end of the list. */
  onStoryPaneDragOver(ev: DragEvent): void {
    if (!this.dragStoryId) return;
    ev.preventDefault();
    if (this.dropBeforeId !== null) {
      this.dropBeforeId = null;
      this.cdr.detectChanges();
    }
  }

  onStoryDrop(ev: DragEvent): void {
    ev.preventDefault();
    const id = this.dragStoryId;
    if (!id) return;
    const moving = this.stories.find(s => s.id === id);
    if (!moving) { this.onStoryDragEnd(); return; }

    // Rebuild the array with the story lifted out, so the drop index is computed against the list
    // it will actually land in — indexing the original array is off by one for a downward move.
    const rest = this.stories.filter(s => s.id !== id);
    let to = this.dropBeforeId ? rest.findIndex(s => s.id === this.dropBeforeId) : rest.length;
    if (to < 0) to = rest.length;
    rest.splice(to, 0, moving);

    this.stories = rest;
    this.dragStoryId = null;
    this.dropBeforeId = null;
    this.renumberStories();      // numbers ARE the export sequence — resequence immediately
    this.scheduleEditsSave();
    this.requestRender();        // the ribbon labels stories by number
    this.cdr.detectChanges();
  }

  onStoryDragEnd(): void {
    if (!this.dragStoryId && this.dropBeforeId === null) return;
    this.dragStoryId = null;
    this.dropBeforeId = null;
    this.cdr.detectChanges();
  }

  // Right-click menu for stories, opened from a list row or a timeline ribbon block. Positioned in
  // viewport coordinates (position: fixed) so the same menu serves both, which sit in different
  // scroll containers.
  storyCtxMenu: { x: number; y: number } | null = null;

  onStoryRowContextMenu(story: Story, ev: MouseEvent): void {
    ev.preventDefault();
    this.openStoryCtxMenu(story.id, ev.clientX, ev.clientY);
  }

  /** Right-click on the timeline ribbon. Ignored (native menu allowed through) anywhere else on
   *  the canvas, so this never steals a right-click from the tracks. */
  onCanvasContextMenu(ev: MouseEvent): void {
    if (!this.hasStories() || this.errorMessage || !this.manifest) return;
    const y = this.canvasEventY(ev);
    if (y <= RULER_H || y > RULER_H + this.ribbonHeight) return;
    const hit = this.storyRegionAtEdited(this.canvasEventTime(ev));
    if (!hit) return;
    ev.preventDefault();
    this.openStoryCtxMenu(hit.storyId, ev.clientX, ev.clientY);
  }

  private openStoryCtxMenu(storyId: string, x: number, y: number): void {
    // Right-clicking OUTSIDE the current pick replaces it with just this story. The menu must only
    // ever act on stories the user can currently see highlighted — never on a pick they made
    // earlier and forgot, which would silently merge the wrong things.
    if (!this.storyMergeIds.has(storyId)) {
      this.storyMergeIds.clear();
      this.storyMergeIds.add(storyId);
      this.requestRender();
    }
    this.storyCtxMenu = { x, y };
    this.cdr.detectChanges();
  }

  closeStoryCtxMenu(): void {
    this.storyCtxMenu = null;
    this.cdr.detectChanges();
  }

  /** Merge from the context menu. Closes first so the menu cannot outlive the stories it names. */
  mergeFromCtxMenu(): void {
    this.closeStoryCtxMenu();
    this.mergeSelectedStories();
  }

  /** Drop the pick. Any plain (unmodified) click does this, so a partial selection can never
   *  linger unnoticed and merge something the user forgot they had picked. */
  private clearStoryMergePick(): void {
    if (this.storyMergeIds.size === 0) return;
    this.storyMergeIds.clear();
    this.requestRender();
    this.cdr.detectChanges();
  }

  /** Merge needs at least two stories ticked. */
  get canMergeStories(): boolean {
    return this.storyMergeIds.size >= 2;
  }

  /**
   * Merge the ticked stories into one. The analyzer sometimes splits a single story in two — this
   * is the manual repair, and the direction that matters, since an over-split is fixable by hand
   * and a missed boundary is not.
   *
   * The FIRST ticked story in list order absorbs the others: it keeps its id, position and title,
   * and takes the union of every region. Immediate and off the undo stack, matching deleteStory.
   */
  mergeSelectedStories(): void {
    const chosen = this.stories.filter(s => this.storyMergeIds.has(s.id));
    if (chosen.length < 2) return;
    const target = chosen[0];

    target.regions = mergeRegions(chosen.flatMap(s => s.regions));
    // The absorbed stories' chapters are deliberately NOT concatenated onto the target any more.
    // A merge redraws the boundary, so what comes out is a new unit: two lists that each chaptered
    // half of it do not chapter the whole, and a title conditioned on the concatenation describes
    // a story that no longer exists. The target keeps its own list, which now reads STALE against
    // the merged regions (its fingerprint cannot match a span it never covered), so it is
    // re-derived on the next demand instead of being trusted. Nothing is destroyed here — nothing
    // is promoted either. That falls out of the fingerprint; it is not an invalidation call.
    // The split cache addresses the span of the OLD story; after a merge it describes neither the
    // new regions nor the right children, so reopening Split must re-detect rather than restore a
    // layout that no longer fits.
    delete target.split;

    const absorbed = new Set(chosen.slice(1).map(s => s.id));
    this.stories = this.stories.filter(s => !absorbed.has(s.id));
    if (this.activeStoryId && absorbed.has(this.activeStoryId)) this.activeStoryId = target.id;
    if (this.storySelection && absorbed.has(this.storySelection.storyId)) this.storySelection = null;

    this.storyMergeIds.clear();
    this.renumberStories();
    this.clearSelection();
    this.scheduleEditsSave();
    this.requestRender();
    this.cdr.detectChanges();
  }

  /** Delete a whole story (immediate, off the undo stack). Clears active/selection if it was this
   *  one, then resequences the remaining story numbers. */
  deleteStory(story: Story): void {
    this.stories = this.stories.filter(s => s.id !== story.id);
    this.storyMergeIds.delete(story.id);
    if (this.activeStoryId === story.id) this.activeStoryId = null;
    if (this.storySelection?.storyId === story.id) this.storySelection = null;
    this.renumberStories();
    this.clearSelection();
    this.scheduleEditsSave();
    this.requestRender();
    this.cdr.detectChanges();
  }

  /** Enter in an inline story field commits by blurring it. */
  blurStoryInput(ev: Event): void {
    (ev.target as HTMLElement | null)?.blur();
  }

  // ── Hand a subject list to the main window's Titles tab ─────────────────────
  // The editor runs in its OWN window, so this cannot be an in-process call: the payload goes
  // through the main process, which focuses the main window and delivers it there. Subjects are
  // sent as BARE LABELS with no timestamps — the title model never sees a clock (the main
  // process strips them again defensively; this just never adds them).

  /** True once a story has something worth titling — its own chapters, or at least a title. */
  canSendStoryToTitles(story: Story): boolean {
    // A story with neither chapters nor a title can still be sent once it has transcript to
    // derive chapters FROM — deriving is the point, so gating on "already has chapters" would
    // hide the button exactly where it is most useful.
    if (this.analyzing) return false;
    return (story.chapters?.length ?? 0) > 0
      || story.title.trim().length > 0
      || (this.transcriptState === 'ready' && !!this.selectedOllamaModel && !this.isStoryEmpty(story));
  }

  /**
   * Send from the story right-click menu: EVERY picked story, not just the one under the cursor.
   * ⌘-picking three stories and sending them has to send three — dropping two silently would be
   * indistinguishable from having sent them.
   *
   * Order is `this.stories` order, which is the story list's order and the timeline's (the list
   * is re-sorted by edited position whenever footage moves — see renumberStoriesByTimeline), so
   * the items land in the Metadata list reading down the timeline. Closes the menu first so it
   * cannot outlive the stories it names.
   */
  async sendStoryToMetadataFromCtxMenu(): Promise<void> {
    const picked = this.stories.filter(s => this.storyMergeIds.has(s.id));
    this.closeStoryCtxMenu();
    if (!picked.length) return;
    await this.sendStoriesToTitles(picked);
  }

  /** Send ONE story — the single-story button on a story row. Same path as a multi-story send. */
  async sendStoryToTitles(story: Story): Promise<void> {
    await this.sendStoriesToTitles([story]);
  }

  /**
   * Send each story's chapter list to the Metadata page as a normal upload — each story becomes
   * its own YouTube video, so its chapters are that video's subject list, and each gets its own
   * handoff in one batch.
   *
   * A STALE list is never sent: markers that describe a span the user has since redrawn point at
   * content this upload does not contain, and a subject list is precisely what a title gets
   * written from, so sending the old one quietly titles the wrong story. ensureStoryChapters
   * re-derives it, or refuses and says why — and a refusal abandons the send rather than reducing
   * it to something weaker.
   *
   * ALL-OR-NOTHING across the batch: readiness runs story by story (a derivation holds the
   * analysing flag, so these cannot overlap), and the FIRST story that refuses abandons the whole
   * send naming itself. Sending the ones that passed would leave the user unable to tell which
   * stories reached the Metadata page without going and counting them.
   */
  async sendStoriesToTitles(stories: Story[]): Promise<void> {
    if (!stories.length) return;
    const many = stories.length > 1;
    // Appended to every refusal in the multi-story case: the user pressed one button and needs
    // told that NOTHING went, not just that one story had a problem.
    const nothingSent = many ? ' Nothing was sent.' : '';
    const handoffs: {
      subjects: string[];
      format: 'normal';
      source: string;
      chapters?: { timestamp: string; title: string }[];
    }[] = [];

    for (const story of stories) {
      const name = story.title.trim() || `Story ${story.number}`;
      let chapters: StoryChapter[];
      try {
        chapters = await this.ensureStoryChapters(story);
      } catch (err: any) {
        // A refusal is shown and the send is abandoned — nothing is sent on a reduced basis.
        this.transportError = (err?.message || String(err)) + nothingSent;
        this.cdr.detectChanges();
        return;
      }
      // The user X'd this story's derivation in the dock mid-send: theirs to drop. It leaves the
      // batch; the remaining stories still go. (Distinct from a FAILED derivation, which refuses
      // the whole send below — a skip is a choice, not a fault.)
      if (this.activitySkipRequested.has(story.id)) continue;
      // ensureStoryChapters reports a failed re-derivation and hands back the old list (a
      // pre-existing fallback, left as found). That list is still stale, and stale is the one thing
      // this send must not do — so the send stops here rather than shipping markers for a span the
      // user has redrawn. The failure itself is already showing in the activity dock.
      if (this.storyChapterState(story) === 'stale') {
        this.transportError =
          `Not sent: “${name}” still has chapters from a ` +
          `different span. Re-derive them first.` + nothingSent;
        this.cdr.detectChanges();
        return;
      }
      // Kept as CHAPTERS, not just labels, so the timestamped list written into the title report
      // is the same set of chapters the model's subject lines came from, in the same order.
      const titled = chapters.filter(c => c.label.trim().length > 0);
      const labels = titled.map(c => c.label.trim());
      // The SUBJECTS are the chapters' DETAIL sentences, not their 4-8 word labels — the titling
      // model was trained on real video descriptions (prose), and terse labels starve it of the
      // names and specifics titles are made of. A chapter without a detail predates the field
      // (or its naming call failed); ensureStoryChapters re-derives those, so reaching here
      // without details means that re-derivation failed — refuse rather than quietly downgrade
      // the model's input to labels.
      const details = titled.map(c => (c.detail || '').trim());
      if (labels.length && details.some(d => d.length === 0)) {
        this.transportError =
          `Not sent: “${name}” has chapters without detail lines (derived before chapter ` +
          `details existed, and re-deriving them failed — see the activity dock).` + nothingSent;
        this.cdr.detectChanges();
        return;
      }
      // PRE-EXISTING FALLBACK: no chapters ⇒ send the bare story title as a one-line subject list.
      // The receiving Titles tab cannot tell a one-subject story from a story whose chaptering
      // failed, so what it produces is a title written from a title. Left as found and flagged.
      const subjects = labels.length ? details : [story.title.trim()].filter(t => t.length > 0);
      if (!subjects.length) {
        this.transportError =
          `Nothing to send for “${name}” — give the story a title or split it into chapters first.` +
          nothingSent;
        this.cdr.detectChanges();
        return;
      }
      // The chapter list rides ALONGSIDE the subjects, for the saved title report only — the
      // titling model must never see a timestamp (headline-integration contract), and nothing
      // downstream appends this to `subjects`. The fallback branch above sends no chapters:
      // a story title is not a chapter and has no time in the story's own video.
      let chapterList: { timestamp: string; title: string }[] | undefined;
      if (labels.length) {
        try {
          chapterList = this.storyChapterTimestamps(story, titled);
        } catch (err: any) {
          // A chapter that maps nowhere is a wiring fault, not a user error — but it still has to
          // be SEEN, so it is shown the way every other refusal on this path is and the whole send
          // is abandoned. Never sent with the bad timestamp dropped or clamped.
          this.transportError = (err?.message || String(err)) + nothingSent;
          this.cdr.detectChanges();
          return;
        }
      }
      handoffs.push({ subjects, format: 'normal', source: name, ...(chapterList ? { chapters: chapterList } : {}) });
    }

    // Every story was X'd out of the batch by the user — nothing left to send, and nothing to
    // report as wrong either.
    if (!handoffs.length) return;
    await this.pushHandoffsToTitles(handoffs);
  }

  /**
   * The story's chapters as `{ timestamp, title }`, timestamped against THE STORY'S OWN exported
   * video rather than the timeline it was cut out of.
   *
   * A chapter's `startSeconds` is a TIMELINE time (same frame as `story.regions`). What the story
   * exports is its regions MINUS the user's cuts, played in sequence order and rebased to 0 —
   * cli/editor_export.py builds each story's kept set with `subtract_cuts(rs, re, global_cuts)`
   * and lays the survivors out in playback order. So the mapping has to be the same one the
   * timeline itself uses: project each region onto the EDITED timeline (editedRangesForOriginal,
   * which is cut- and reorder-aware), and a chapter's position is how much of the story has
   * already played by its edited time. Summing raw region lengths instead would push every marker
   * after a cut late by the whole cut — a real session had a 5m26s cut mid-story.
   *
   * A start just OUTSIDE every piece is snapped to the nearest piece edge, within EDGE_SNAP.
   * Chapter boundaries are placed from a mapped quote, and segmentsForRegions hands a region the
   * segments whose spans STRADDLE its edges — a segment belongs to both sides — so a boundary can
   * legitimately land a fraction of a second before a region starts or after it ends. (Seen in
   * real edits: a first chapter at 1767.835 against a first region starting at 1768.2665.) Two
   * seconds is comfortably clear of that fuzz and far below the ~45 s stretch the placement works
   * in, so it can never hide a marker that is genuinely in the wrong place.
   *
   * Further out than that, the chapter belongs to a span this story does not export, which is a
   * wiring fault: it THROWS naming the story and the time. It is not clamped to the nearest piece
   * and not dropped — a chapter list is what the user clicks in the published video, and a marker
   * quietly moved to a plausible-looking time is worse than a send that refuses.
   *
   * A chapter whose content was entirely CUT lands on the seam the cut left, because that is where
   * originalToEdited puts it and it is the only honest answer: the material it named is not in the
   * video. The subject line still goes to the titler, exactly as it does today.
   */
  private storyChapterTimestamps(
    story: Story,
    chapters: StoryChapter[]
  ): { timestamp: string; title: string }[] {
    const name = story.title.trim() || `Story ${story.number}`;
    // The story's surviving footage in PLAYBACK order: edited time is sequence order by
    // construction (rebuildEditedModel accumulates `es` walking the sequence), so sorting by `lo`
    // is the order the exporter concatenates these pieces in.
    const pieces = mergeRegions(story.regions)
      .flatMap(r => this.editedRangesForOriginal(r.start, r.end))
      .sort((a, b) => a.lo - b.lo);
    if (!pieces.length) {
      throw new Error(
        `“${name}” keeps no footage once its cuts are applied, so its chapters have nowhere to ` +
        `land — remove the cut or redraw the story.`
      );
    }
    // Piece ends are frame-quantized, so a chapter sitting exactly on one can miss it by a hair's
    // breadth of floating point. 10 ms is under half a frame.
    const EDGE = 0.01;
    const EDGE_SNAP = 2.0;   // see the doc comment: quote-placement fuzz at a region edge

    // Output position of an edited time known to sit inside `pieces[index]`.
    const outputAt = (index: number, edited: number): number => {
      let before = 0;
      for (let i = 0; i < index; i++) before += pieces[i].hi - pieces[i].lo;
      return before + Math.max(0, Math.min(edited, pieces[index].hi) - pieces[index].lo);
    };

    return chapters.map(c => {
      // POINT map — a chapter start is a point, so the non-monotonic reorder caveat on
      // originalToEdited does not apply.
      const et = this.originalToEdited(c.startSeconds);
      const inside = pieces.findIndex(p => et >= p.lo - EDGE && et <= p.hi + EDGE);
      if (inside !== -1) {
        return { timestamp: formatRulerLabel(Math.floor(outputAt(inside, et))), title: c.label.trim() };
      }

      // Outside every piece: snap to the nearest EDGE if it is within the placement fuzz.
      let best = -1;
      let bestGap = Infinity;
      let bestTime = 0;
      pieces.forEach((p, i) => {
        for (const edge of [p.lo, p.hi]) {
          const gap = Math.abs(et - edge);
          if (gap < bestGap) { bestGap = gap; best = i; bestTime = edge; }
        }
      });
      if (best !== -1 && bestGap <= EDGE_SNAP) {
        return { timestamp: formatRulerLabel(Math.floor(outputAt(best, bestTime))), title: c.label.trim() };
      }

      throw new Error(
        `Chapter “${c.label.trim()}” of “${name}” starts at ${c.startSeconds.toFixed(2)}s, which is ` +
        `outside every part of that story the export keeps — its position in the exported video ` +
        `cannot be worked out.`
      );
    });
  }

  /**
   * The story's chapter markers, DERIVING them when they are missing or stale — the lazy, one-off
   * entry into run 2. Owns the analysing flag, so it refuses while another run holds it; the bulk
   * run calls deriveStoryChapters directly instead.
   *
   * A story's own chapters are the only ones worth having: the pipeline's cadence is
   * duration-derived, so a ~20-minute story lands at ~3.5 min/chapter — normal YouTube spacing,
   * and finer than the ~6 min the same pipeline gives a multi-hour recording. Chapters carried
   * over from a whole-recording run were cut at that coarser cadence and before the user drew this
   * boundary, which is why they read stale and are re-derived here.
   *
   * Derived chapters are persisted onto the story, so this cost is paid once per boundary.
   */
  private async ensureStoryChapters(story: Story): Promise<StoryChapter[]> {
    const state = this.storyChapterState(story);
    // Fresh chapters WITHOUT detail lines were derived before the detail field existed (or their
    // naming call fell back to opening words). Titling subjects are the details, so a list
    // without them is as unusable for a send as a stale one — re-derive it the same way.
    const undetailed = state === 'fresh' && story.chapters!.some(c => !(c.detail || '').trim());
    if (state === 'fresh' && !undetailed) return story.chapters!;
    if (!this.selectedOllamaModel || this.transcriptState !== 'ready' || this.analyzing) {
      // STALE (or detail-less) and unable to re-derive is a refusal, not a shrug. Handing these
      // back would send markers that describe a span the user has since redrawn — and because a
      // subject list is what a title gets written from, the only symptom would be a confidently
      // wrong title for the wrong story. Say what is missing and stop.
      if (state === 'stale' || undetailed) {
        throw new Error(
          `“${story.title || 'This story'}” has ` +
          (undetailed ? 'chapters without detail lines' : 'chapters from a different span') +
          ` and they cannot be re-derived right now — ` +
          (this.analyzing ? 'an analysis is already running.'
            : this.transcriptState !== 'ready' ? 'the session has no transcript yet.'
            : 'no Ollama model is selected.')
        );
      }
      // PRE-EXISTING FALLBACK (state === 'none'): returns [], and sendStoryToTitles then sends the
      // bare story title instead. Left exactly as it was — flagged, not changed.
      return story.chapters ?? [];
    }

    this.analyzing = true;
    this.analyzeStopRequested = false;
    this.analyzeError = null;
    this.aiProgressDone = 0;
    this.aiProgressTotal = 0;
    this.activityOpen = true;
    // A queue of one — the dock renders every analysis the same way, however it was started.
    this.activityQueueStart([{ id: story.id, label: story.title.trim() || `Story ${story.number}` }]);
    this.cdr.detectChanges();
    try {
      return await this.deriveStoryChapters(story, this.selectedOllamaModel);
    } catch (err: any) {
      // PRE-EXISTING FALLBACK: a failed derivation is reported into the activity dock and the
      // story's old (possibly stale, possibly absent) markers are handed back, so the caller
      // carries on with the wrong list or with the bare title. Left as found and flagged; the
      // bulk run deliberately does NOT get this treatment (deriveStoryChapters throws).
      if (!this.isStopError(err)) this.analyzeError = err?.message || String(err);
      return story.chapters ?? [];
    } finally {
      await this.electron.unloadStoryModel({ model: this.selectedOllamaModel }).catch(() => { /* housekeeping */ });
      this.analyzing = false;
      this.analyzeStopRequested = false;
      this.analyzeMessage = '';
      this.activityQueue = [];   // the run is over however it ended — no row may outlive it
      this.cdr.detectChanges();
    }
  }

  /**
   * Run 2's chapter half for ONE story: chapter this story's own span and persist the result.
   * Assumes the caller already holds the analysing flag and will unload the model.
   *
   * THROWS on every failure — no path here returns the story's old markers. A chapter list is what
   * a title is written from and what a description ships, so a derivation that quietly hands back
   * the previous list produces a wrong result nothing downstream can tell from a right one.
   *
   * `consolidate: false` is the correctness switch, not an optimisation. Stage 5 exists to decide
   * where one story ends and the next begins; inside a story the user has DECLARED there is no
   * such seam, so every merge it makes is a false positive that flattens two real chapters into
   * one — measured on a single-story span it turned 5 chapters into 3, and on an hour-long span in
   * a stubbed harness 10 into 3. With it off the returned chapters ARE the chapter layer, and each
   * carries itself as its only `subChapter`; more than one means stage 5 ran, which can only mean
   * the flag never reached the pipeline. That is checked rather than compensated for: silently
   * reading the sub-tier instead would hide broken wiring behind chapters cut at story cadence.
   *
   * The check is one-sided by nature: consolidation stops at a three-chapter floor, so a story that
   * yields three or fewer chapters never merges and the flag being dropped costs nothing there —
   * nothing to detect, and nothing lost.
   *
   * The fingerprint is taken BEFORE the run: hundreds of model calls take minutes, the user can
   * move the story's edges while they run, and stamping the regions as they are afterwards would
   * mark chapters fresh for a span they never saw.
   */
  private async deriveStoryChapters(story: Story, model: string): Promise<StoryChapter[]> {
    const name = story.title.trim() || `Story ${story.number}`;
    const regions = mergeRegions(story.regions);
    const segments = this.segmentsForRegions(regions);
    if (segments.length === 0) {
      throw new Error(`“${name}” has no transcript in its regions — nothing to chapter.`);
    }
    const from = regionFingerprint(regions);

    this.analyzeMessage = `Finding chapters in “${name}”…`;
    this.cdr.detectChanges();

    const res = await this.electron.analyzeStoryChapters({ segments, model, consolidate: false });
    const returned = res.chapters || [];
    if (returned.some(c => (c.subChapters?.length ?? 0) > 1)) {
      // Marked as a WIRING fault, not a data one: it will fail identically for every story, so a
      // bulk run must stop here rather than spend another full pipeline pass per story proving it.
      throw Object.assign(
        new Error(
          `Chapter analysis consolidated “${name}” into stories when it was told not to: the ` +
          `story:analyze-chapters IPC handler is dropping \`consolidate: false\`. Its chapters would ` +
          `be cut at story cadence, merging real chapters away. Check the forwarding in ` +
          `electron/ipc/ipc-handlers.ts and that the running build is current.`
        ),
        { wiringFault: true },
      );
    }
    const derived = returned
      .map(c => ({
        startSeconds: c.startSeconds, endSeconds: c.endSeconds, label: cleanChapterLabel(c.label),
        ...((c.detail || '').trim() ? { detail: c.detail.trim() } : {}),
        ...(c.startApprox ? { startApprox: true } : {}),
      }))
      .sort((a, b) => a.startSeconds - b.startSeconds);
    // Fewer than two is not a short chapter list, it is a failed one — the pipeline's own boundary
    // count floors at three chapters for any span, so this only happens when placement dropped
    // nearly everything.
    if (derived.length < 2) {
      throw new Error(`Chapter analysis returned ${derived.length} chapter(s) for “${name}” — not a usable chapter list.`);
    }
    setStoryChapters(story, derived, from);
    this.scheduleEditsSave();
    this.requestRender();
    return derived;
  }

  /**
   * Send EVERY story to the Metadata queue, each as its own item — every story is its own
   * upload, so each arrives with its own chapter list and queues for its own title run.
   * Same all-or-nothing readiness path as the right-click send: chapters are derived where
   * missing or stale, and the first story that refuses abandons the whole send.
   *
   * (This button used to send ONE livestream handoff made of the story TITLES — "title the
   * stream itself". That predates the per-story queue; if stream-titling is wanted again it
   * needs its own affordance, not this button.)
   */
  async sendAllStoriesToTitles(): Promise<void> {
    if (!this.stories.length) {
      this.transportError = 'No stories to send — define at least one story first.';
      return;
    }
    await this.sendStoriesToTitles(this.stories);
  }

  /** The one wire call: a batch of handoffs, one per upload. Sent whole or not at all. */
  private async pushHandoffsToTitles(
    handoffs: {
      subjects: string[];
      format: 'normal' | 'livestream';
      source: string;
      /** Story-relative chapter times, for the saved title report only — never model input. */
      chapters?: { timestamp: string; title: string }[];
    }[]
  ): Promise<void> {
    this.transportError = '';
    try {
      await this.electron.sendSubjectsToTitles({ handoffs });
    } catch (err: any) {
      // Verbatim — the usual cause is the main window having been closed, which the user
      // needs told rather than a button that silently does nothing.
      this.transportError = err?.message || String(err);
    }
    this.cdr.detectChanges();
  }

  /** Total EDITED duration of a story (sum of its regions), as "Xh Ym" / "Ym Zs" / "Zs" — how
   *  long the story runs, not where it sits. A region count is appended when it has more than
   *  one. Tracks cuts via originalToEdited. */
  storyDuration(story: Story): string {
    const regions = mergeRegions(story.regions);
    if (regions.length === 0) return '—';
    let total = 0;
    for (const r of regions) {
      // Summed per surviving PIECE: a reordered region's ends can map out of order, and the old
      // end-minus-start would clamp to 0 and report a story as empty when it is not.
      for (const p of this.editedRangesForOriginal(r.start, r.end)) total += p.hi - p.lo;
    }
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = Math.floor(total % 60);
    const dur = h > 0 ? `${h}h ${m}m` : (m > 0 ? `${m}m ${s}s` : `${s}s`);
    const count = regions.length > 1 ? `  ·  ${regions.length} parts` : '';
    return `${dur}${count}`;
  }

  /** Ribbon edge hit-test: the story-region edge within ±5 css px of `x`, or null. Checks
   *  display (merged) regions, whose indices match the story's canonicalized regions array. */
  private storyEdgeAtX(x: number): { storyId: string; regionIndex: number; edge: 'start' | 'end' } | null {
    const TOL = 5;
    for (const s of storiesForDisplay(this.stories)) {
      for (let i = 0; i < s.regions.length; i++) {
        const r = s.regions[i];
        // The grabbable edges are the region's OUTER ends: its first piece's left and its last
        // piece's right. A region split across a reorder exposes no handle on the interior seams —
        // dragging one would redefine the region bound to a time on the far side of the move.
        const pieces = this.editedRangesForOriginal(r.start, r.end);
        if (pieces.length === 0) continue;
        const x0 = this.timeToX(pieces[0].lo);
        const x1 = this.timeToX(pieces[pieces.length - 1].hi);
        if (x1 - x0 <= 1) continue;                       // collapsed at this zoom — not grabbable
        if (Math.abs(x - x1) <= TOL) return { storyId: s.id, regionIndex: i, edge: 'end' };
        if (Math.abs(x - x0) <= TOL) return { storyId: s.id, regionIndex: i, edge: 'start' };
      }
    }
    return null;
  }

  /** Live update of a grabbed story-region edge: pointer time HARD-quantized to the nearest
   *  cut boundary (whole sections only), mapped to ORIGINAL seconds, clamped to the timeline
   *  and to one frame of minimum region width. */
  private updateStoryEdgeDrag(ev: MouseEvent): void {
    const drag = this.draggingStoryEdge!;
    const story = this.stories.find(s => s.id === drag.storyId);
    const region = story?.regions[drag.regionIndex];
    if (!story || !region) { this.draggingStoryEdge = null; return; }
    const fs = this.manifest?.frameSeconds || (1001 / 30000);
    const durOrig = this.manifest?.timelineDuration || 0;
    const tEdited = this.snapEdited(this.canvasEventTime(ev), false, Infinity);
    const t = Math.min(durOrig, Math.max(0, this.editedToOriginal(tEdited)));
    if (drag.edge === 'start') {
      region.start = Math.max(0, Math.min(t, region.end - fs));
    } else {
      region.end = Math.min(durOrig, Math.max(t, region.start + fs));
    }
    this.requestRender();
  }

  /** Canvas hover feedback: ew-resize over a grabbable story-region edge in the ribbon
   *  (inline cursor overrides the tool-class cursor; '' restores it). */
  onCanvasHover(ev: MouseEvent): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    if (this.moveDrag) { canvas.style.cursor = 'grabbing'; return; }
    let over = false;
    if (this.hasStories() && !this.draggingStoryEdge) {
      const y = this.canvasEventY(ev);
      if (y > RULER_H && y <= RULER_H + this.ribbonHeight) {
        over = !!this.storyEdgeAtX(this.timeToX(this.canvasEventTime(ev)));
      }
    }
    if (over || this.draggingStoryEdge) { canvas.style.cursor = 'ew-resize'; return; }
    // A highlight in a track lane is grabbable — the grab cursor IS the discoverability of the
    // move gesture, which has no other affordance.
    if (this.toolMode === 'select' && this.rowAt(this.canvasEventY(ev))) {
      const t = this.canvasEventTime(ev);
      if (this.allSelectionRanges().some(r => t > r.lo + EPS && t < r.hi - EPS)) {
        canvas.style.cursor = 'grab';
        return;
      }
    }
    canvas.style.cursor = '';
  }

  /** The story CHUNK (merged-region index) whose span contains edited time `t`, or null. First
   *  hit in number order wins (matches storyAtEdited). The index addresses the story's CANONICAL
   *  (merged) regions — selectStoryChunk canonicalizes before using it. */
  private storyRegionAtEdited(t: number): { storyId: string; regionIndex: number } | null {
    for (const s of storiesForDisplay(this.stories)) {
      for (let i = 0; i < s.regions.length; i++) {
        for (const p of this.editedRangesForOriginal(s.regions[i].start, s.regions[i].end)) {
          if (t >= p.lo - EPS && t <= p.hi + EPS) return { storyId: s.id, regionIndex: i };
        }
      }
    }
    return null;
  }

  /** Reflect a resolved story's region(s) into the timeline selection and scroll into view. */
  private selectResolvedStory(s: { regions: { start: number; end: number }[] }): void {
    const ranges: { start: number; end: number }[] = [];
    for (const r of s.regions) {
      // One highlight band per edited piece — selectedRanges is already a LIST, so a region
      // scattered by a reorder highlights all of its footage rather than one bogus span.
      for (const p of this.editedRangesForOriginal(r.start, r.end)) {
        ranges.push({ start: p.lo, end: p.hi });
      }
    }
    this.selStart = null;
    this.selEnd = null;
    this.selectedGroupStart = null;
    this.selectedGroupEnd = null;
    this.selectedRanges = ranges;
    this.ensureRangesVisible(ranges);
  }

  /** Scroll so the earliest of `ranges` is on screen (reuses clampScroll). No-op if empty. */
  private ensureRangesVisible(ranges: { start: number; end: number }[]): void {
    if (ranges.length === 0) return;
    let lo = Infinity, hi = -Infinity;
    for (const r of ranges) { if (r.start < lo) lo = r.start; if (r.end > hi) hi = r.end; }
    const left = this.scrollOffset;
    const right = this.scrollOffset + this.viewportSec;
    if (lo < left || hi > right) {
      this.scrollOffset = this.clampScroll(lo - this.viewportSec * 0.1);
    }
  }

  // ── Story analysis (Ollama): model picker, chapter split, title suggestion ───

  /** (Re)load the list of locally-installed Ollama models and reconcile the selection. */
  async refreshOllamaModels(): Promise<void> {
    if (!this.electron.isElectron()) return;
    try {
      const res = await this.electron.ollamaListModels();
      this.ollamaConnected = res.connected;
      this.ollamaModels = res.models || [];
      const saved = localStorage.getItem(this.OLLAMA_MODEL_KEY) || '';
      const has = (id: string) => this.ollamaModels.some(m => m.id === id);
      if (saved && has(saved)) this.selectedOllamaModel = saved;
      else if (!has(this.selectedOllamaModel)) this.selectedOllamaModel = this.defaultOllamaModel();
    } catch {
      this.ollamaConnected = false;
      this.ollamaModels = [];
    }
    this.cdr.detectChanges();
  }

  /**
   * First-run model default: `cogito:14b` — the BASE model, and the eventual base for the YouTube
   * metadata adapters, so everything downstream conditions on the same weights. Matching is exact
   * (plus Ollama's implicit `:latest`) so a fine-tune built on it is never picked up by accident.
   *
   * Falls back to qwen2.5:14b (the validated rater), then any 14B, then whatever is installed.
   * 14B is the floor — smaller models fail by MISSING boundaries, the one error a user cannot fix
   * by joining chapters. Only applies when the user has never picked a model; their choice wins.
   */
  private defaultOllamaModel(): string {
    const ids = this.ollamaModels.map(m => m.id);
    const exact = (want: string) => ids.find(id => id === want || id === `${want}:latest`);
    return exact('cogito:14b')
        || exact('qwen2.5:14b')
        || ids.find(id => /(^|:)14b($|:)/i.test(id))
        || ids[0]
        || '';
  }

  /**
   * Stop the running analysis — the X on the activity dock entry and on the Split dialog.
   *
   * Two halves, both needed: the main process aborts the in-flight HTTP call (so a stop lands
   * within a call rather than after it), and `analyzeStopRequested` breaks the renderer's own
   * per-story titling loop, which would otherwise just start the next story.
   */
  async stopAnalysis(): Promise<void> {
    if (!this.analyzing && !this.splitRunning) return;
    this.analyzeStopRequested = true;
    this.analyzeMessage = 'Stopping…';
    this.aiPhase = 'Stopping…';
    this.cdr.detectChanges();
    try {
      await this.electron.cancelStoryAnalysis();
    } catch {
      // Nothing was running, or the bridge is gone — the loop flag still ends it.
    }
  }

  /** True when an error is really a user-initiated stop, which must never surface as a failure. */
  private isStopError(err: any): boolean {
    const name = err?.name || '';
    const msg = String(err?.message || err || '');
    return this.analyzeStopRequested
      || name === 'AnalysisCancelledError'
      || name === 'OllamaCancelledError'
      || /Analysis stopped\.|OllamaCancelledError|AnalysisCancelledError/.test(msg);
  }

  /** Model picker change — persist the choice. */
  onOllamaModelChange(id: string): void {
    this.selectedOllamaModel = id;
    if (id) localStorage.setItem(this.OLLAMA_MODEL_KEY, id);
  }

  // Sentence-ish segmentation for the analyzer. A transcript GROUP is one timeline clip's worth of
  // speech, which on an uncut recording can be the whole hour — far too coarse to feed the chapter
  // pipeline, which cuts at 45 s and maps a quoted sentence to the start time of the segment it
  // lands in. Coarse segments break it two ways: whole minutes collapse into a single 45 s stretch
  // (the rest come out empty and are dropped), and a mapped quote resolves only to its clip's
  // start, so a chapter that must land within ~5 s could be minutes off. So segments are built
  // from WORDS, which carry real per-word timings.
  private readonly SEG_MAX_WORDS = 20;    // hard cap, so a run without punctuation still breaks up
  private readonly SEG_MIN_WORDS = 4;     // don't emit "Yeah." as its own segment
  private readonly SEG_GAP_SECONDS = 2;   // a pause this long ends a segment regardless of text

  /**
   * Transcript segments ({text, startSeconds, endSeconds} in ORIGINAL seconds) overlapping the
   * given ORIGINAL-second regions, chronological. Empty when nothing was transcribed there.
   *
   * Built per track (so two people talking at once don't interleave mid-sentence) and then merged
   * in timeline order — the same ordering the group-level view uses, just at sentence granularity.
   */
  private segmentsForRegions(regions: { start: number; end: number }[]): { text: string; startSeconds: number; endSeconds: number; speaker: 'host' | 'clip' }[] {
    const words = (this.transcript?.words || []).filter(w =>
      regions.some(r => w.timelineEnd > r.start + EPS && w.timelineStart < r.end - EPS)
    );
    if (words.length === 0) return [];

    const byTrack = new Map<string, TranscriptWord[]>();
    for (const w of words) {
      let arr = byTrack.get(w.track);
      if (!arr) { arr = []; byTrack.set(w.track, arr); }
      arr.push(w);
    }

    const out: { text: string; startSeconds: number; endSeconds: number; speaker: 'host' | 'clip' }[] = [];
    for (const [trackId, arr] of byTrack.entries()) {
      const speaker = this.speakerForTrack(trackId);
      arr.sort((a, b) => a.timelineStart - b.timelineStart);
      let buf: TranscriptWord[] = [];
      const flush = () => {
        if (buf.length === 0) return;
        const text = buf.map(w => w.text).join(' ').replace(/\s+/g, ' ').trim();
        if (text) {
          out.push({
            text,
            startSeconds: buf[0].timelineStart,
            endSeconds: buf[buf.length - 1].timelineEnd,
            speaker,
          });
        }
        buf = [];
      };
      for (let i = 0; i < arr.length; i++) {
        const w = arr[i];
        // A pause, or a jump to another timeline clip, ends the current sentence before this word.
        const prev = buf[buf.length - 1];
        if (prev && (w.timelineStart - prev.timelineEnd > this.SEG_GAP_SECONDS || w.group !== prev.group)) flush();
        buf.push(w);
        const endsSentence = /[.!?]["')\]]?$/.test(w.text.trim());
        if ((endsSentence && buf.length >= this.SEG_MIN_WORDS) || buf.length >= this.SEG_MAX_WORDS) flush();
      }
      flush();
    }
    out.sort((a, b) => a.startSeconds - b.startSeconds);
    return out;
  }

  /**
   * Which side of the commentary a transcript track records: the host's mic, or the screen
   * capture of the footage being reacted to. Chapter naming (stage 4) renders its transcript
   * with HOST:/CLIP: tags built from this — without them the model cannot tell the host's
   * verdict from the footage's claim and misattributes who said what (audition3, 2026-08-03).
   * A track that is neither is a labelling gap this cannot paper over, so it refuses and
   * names the track rather than guessing a side.
   */
  private speakerForTrack(trackId: string): 'host' | 'clip' {
    const label = (this.transcriptTracks.find(t => t.id === trackId)?.label || '').toLowerCase();
    if (label.includes('mic')) return 'host';
    if (label.includes('screen')) return 'clip';
    throw new Error(
      `Transcript track "${trackId}"${label ? ` (“${label}”)` : ''} is neither a mic nor a ` +
      `screen track — cannot tell host speech from footage for chapter analysis.`
    );
  }

  /** Concatenated transcript text for a set of ORIGINAL-second regions (for title suggestion). */
  private transcriptTextForRegions(regions: { start: number; end: number }[]): string {
    return this.segmentsForRegions(regions).map(s => s.text).join(' ').trim();
  }

  /**
   * Analyze the whole timeline from the Stories tab — the two runs, chosen by whether stories
   * exist yet.
   *
   * RUN 1 (no stories): split the whole transcript into stories by subject change. Its job is
   * finding the story BOUNDARIES; the user then curates — merging what it over-split, reordering,
   * naming. The sub-chapters it retains ride along as provisional markers.
   *
   * RUN 2 (stories exist): per story, in order — chapter that story on its own terms, then write a
   * working title from those chapters. A story whose chapters are already fresh, and a title the
   * user typed, both cost nothing. Stoppable between stories as well as mid-call.
   */
  async analyzeTimeline(): Promise<void> {
    if (this.analyzing || !this.selectedOllamaModel || this.transcriptState !== 'ready') return;
    const model = this.selectedOllamaModel;
    this.analyzing = true;
    this.analyzeStopRequested = false;
    this.analyzeError = null;
    this.aiProgressDone = 0;
    this.aiProgressTotal = 0;
    this.aiPhase = '';
    this.activityOpen = true;   // surface progress in the floating dock
    this.cdr.detectChanges();
    try {
      if (this.hasStories()) {
        // One pass per story that has transcript to work from (empties and scrap excluded).
        const workable = this.stories.filter(s => this.transcriptTextForRegions(mergeRegions(s.regions)));
        // The whole run, listed in the dock up front: story 1 running, the rest waiting. Each row
        // is removed as its story finishes, so "how much is left" is the list itself and the bar
        // below is free to mean one thing only — see the scale note at the top of the loop.
        this.activityQueueStart(workable.map(s => ({ id: s.id, label: s.title.trim() || `Story ${s.number}` })));
        // One story failing does not end the run. This loop is potentially hours of model calls
        // across every story in the session; abandoning the rest because one story's placement
        // collapsed would be a worse bug than the one it guards against. The failure is NOT
        // hidden, though — the story keeps its old markers, which the list already shows as stale,
        // it is not given a title written off a list that failed, and every failure is named at
        // the end. A wiring fault (below) is different and does stop the run: it will fail
        // identically for every story, and each retry costs another full pipeline pass.
        const failures: string[] = [];
        for (const s of workable) {
          if (this.analyzeStopRequested) break;   // stop between stories, not just mid-call
          // X'd while waiting: its dock row is already gone — it is simply never visited. Not a
          // failure and not advanced (cancelPendingActivity removed the row itself).
          if (this.activitySkipRequested.has(s.id)) continue;
          // THE BAR IS ONE SCALE: this story's chapter-pipeline call progress, as reported by
          // onStoryAnalyzeProgress. Zeroed here so the previous story's tally can never be read as
          // this one's, and left at 0 (indeterminate) for the stretches that report no calls.
          // Story-level progress is the queue below it, not a second scale in the same bar.
          this.aiProgressDone = 0;
          this.aiProgressTotal = 0;
          this.aiPhase = '';
          this.analyzeMessage = '';
          const name = s.title.trim() || `Story ${s.number}`;

          try {
            // Chapters first — the title is written FROM them, so this order is the whole point.
            // A fresh list is reused rather than re-derived: "fresh" means its fingerprint still
            // matches these exact regions, so re-running could only reproduce it.
            const chapters = this.storyChapterState(s) === 'fresh'
              ? s.chapters!
              : await this.deriveStoryChapters(s, model);
            if (this.analyzeStopRequested) break;

            // A title the user typed is left exactly as they typed it. They name stories between
            // run 1 and run 2, so overwriting here would destroy that work with no undo.
            if (!s.titleTouched) {
              // The subject list, and only the subject list. There is no transcript path here: the
              // chapters were just derived from this story's own span, so if they are unusable the
              // answer is to report that, not to write a title from a 12k-char splice that
              // discards its own middle.
              const subjects = chapters.map(c => c.label.trim()).filter(l => l.length > 0);
              if (subjects.length < 2) {
                throw new Error('produced no usable chapter labels to title from');
              }
              this.analyzeMessage = `Titling “${name}”…`;
              // One model call with no step reporting — the bar goes indeterminate rather than
              // freeze on the chapter run's finished tally, which would read as stalled work.
              this.aiProgressDone = 0;
              this.aiProgressTotal = 0;
              this.cdr.detectChanges();
              const res = await this.electron.suggestStoryTitle({ text: subjects, model });
              s.title = res.title;
              this.scheduleEditsSave();
              this.requestRender();
            }
          } catch (err: any) {
            if (this.isStopError(err)) {
              // A per-story X aborts exactly the way a stop does; the intent lives in the skip
              // set. Skipped ⇒ this story only — fall through to the advance and keep going.
              // Not in the set ⇒ the stop button — the run ends here.
              if (!this.activitySkipRequested.has(s.id)) break;
            } else if (err?.wiringFault) {
              throw err;
            } else {
              failures.push(`${name}: ${err?.message || String(err)}`);
            }
          }

          // Done with this story — succeeded, skipped by its X, or skipped after failing (the
          // failure is reported at the end of the run). Its row drops off the top and the next
          // story becomes running.
          this.activityQueueAdvance();
          this.cdr.detectChanges();
        }
        // Named, not counted — "2 stories failed" tells the user nothing they can act on, and the
        // stories that failed are exactly the ones still showing stale chapters.
        if (failures.length) {
          throw new Error(
            `${failures.length} of ${workable.length} stories could not be chaptered or titled ` +
            `(the rest were done):\n• ${failures.join('\n• ')}`
          );
        }
      } else {
        // Run 1 has no stories to queue yet — it is the one pass that finds them, so it is one row.
        this.activityQueueStart([{ id: 'timeline', label: 'Analyzing stories' }]);
        this.analyzeMessage = 'Splitting the timeline into stories…';
        this.cdr.detectChanges();
        const dur = this.manifest?.timelineDuration || 0;
        const segments = this.segmentsForRegions([{ start: 0, end: dur > 0 ? dur : Number.MAX_SAFE_INTEGER }]);
        if (segments.length === 0) throw new Error('No transcript to analyze.');
        const res = await this.electron.analyzeStoryChapters({ segments, model: this.selectedOllamaModel });
        const chapters = res.chapters || [];
        if (chapters.length === 0) throw new Error('No stories detected.');
        const created: Story[] = chapters.map((c, i) => {
          const story: Story = {
            id: `story-${++this.storyIdCounter}`,
            number: i + 1,
            title: cleanChapterLabel(c.label) || `Story ${i + 1}`,
            regions: [{ start: c.startSeconds, end: c.endSeconds }],
          };
          // PROVISIONAL (no fingerprint): these sub-chapters were cut at whole-recording cadence
          // — ~6 min apart on a multi-hour stream where this story wants ~3.5 — and before the
          // user curated the boundary. They are worth keeping as markers, but run 2 must re-derive
          // them rather than accept them as this story's chapter layer.
          setStoryChapters(story, toStoryChapters(c.subChapters), null);
          return story;
        });
        this.stories = [...this.stories, ...created];
        this.renumberStories();
        this.scheduleEditsSave();
        this.requestRender();
      }
    } catch (err: any) {
      // A stop is not an error — the user asked for it.
      this.analyzeError = this.isStopError(err) ? null : (err?.message || String(err));
    } finally {
      // Down the moment the run ends — finished, failed or stopped. Ollama would otherwise hold
      // the weights for its own keep_alive (minutes), and nothing here needs them again.
      // The chapter path also unloads in the main process; a second unload is a harmless no-op.
      await this.electron.unloadStoryModel({ model }).catch(() => { /* housekeeping only */ });
      this.analyzing = false;
      this.analyzeStopRequested = false;
      this.analyzeMessage = '';
      // Emptied here and only here for the bulk run: a stop, a wiring fault or a crash all land in
      // this finally, so no path can leave the dock listing stories that will never run.
      this.activityQueue = [];
      this.cdr.detectChanges();
    }
  }

  /** Open the Split modal for a story. If a cached analysis exists it loads instantly (reworkable
   *  without re-running the model, with the last layout restored); otherwise it waits idle until
   *  the user picks a model and hits Start. */
  openSplitModal(story: Story): void {
    this.splitStory = story;
    this.splitStoryTitle = story.title;
    this.splitModalOpen = true;
    this.splitError = null;
    this.splitRunning = false;
    this.splitActiveBucket = 0;
    this.aiProgressDone = 0;
    this.aiProgressTotal = 0;
    this.aiPhase = '';
    const cache = story.split;
    if (cache && cache.chapters?.length) {
      this.splitChapters = cache.chapters.map(c => ({ ...c }));
      this.splitAssign = [...cache.assign];
      this.splitBuckets = cache.buckets.map(b => ({ title: b.title, touched: b.touched }));
      this.splitAnalyzedRegions = cache.regions.map(r => ({ ...r }));
      this.splitFromCache = true;
    } else {
      this.splitChapters = [];
      this.splitAssign = [];
      this.splitBuckets = [{ title: story.title }];
      this.splitAnalyzedRegions = [];
      this.splitFromCache = false;
    }
    this.cdr.detectChanges();
  }

  /** Save the current chapter analysis + layout onto the story so a reopen is instant. Preserves
   *  the childIds from the prior Apply (rework replaces them). */
  private persistSplitCache(childIds?: string[]): void {
    const story = this.splitStory;
    if (!story || !this.splitChapters.length) return;
    story.split = {
      regions: this.splitAnalyzedRegions.map(r => ({ ...r })),
      chapters: this.splitChapters.map(c => ({ ...c })),
      assign: [...this.splitAssign],
      buckets: this.splitBuckets.map(b => ({ title: b.title, touched: b.touched })),
      childIds: childIds ?? story.split?.childIds ?? [],
    };
    this.scheduleEditsSave();
  }

  /** Start (or re-run) chapter detection on the open story with the CURRENT model — the Start
   *  button in the modal header. Switching the model dropdown and hitting it again re-detects. */
  async startSplit(): Promise<void> {
    if (!this.splitStory || this.splitRunning) return;
    await this.runSplitDetection();
  }

  /** Detect chapters for the open split story with the selected model. The chapters always tile
   *  the story's full span (first→start, last→end), so coverage is complete even when a weak model
   *  under-segments; the modal surfaces that via the coverage summary. */
  private async runSplitDetection(): Promise<void> {
    const story = this.splitStory;
    if (!story) return;
    this.splitError = null;
    this.splitChapters = [];
    this.splitAssign = [];
    if (!this.selectedOllamaModel) {
      this.splitError = 'Pick an Ollama model first (dropdown at the top of this dialog).';
      this.splitRunning = false;
      this.cdr.detectChanges();
      return;
    }
    // Re-run re-detects the SAME section that was first analyzed (sticky span from the cache), so
    // reworking after an Apply doesn't silently re-scope to the story's shrunken leftover regions.
    // A first run (no cache yet) analyzes the story's current regions.
    const regions = this.splitAnalyzedRegions.length ? this.splitAnalyzedRegions : mergeRegions(story.regions);
    this.splitRunning = true;
    this.analyzeStopRequested = false;
    this.splitFromCache = false;
    this.aiProgressDone = 0;
    this.aiProgressTotal = 0;
    this.aiPhase = 'Starting…';
    this.cdr.detectChanges();
    try {
      const segments = this.segmentsForRegions(regions);
      if (segments.length === 0) throw new Error('No transcript in this story to split. Transcribe first.');
      const res = await this.electron.analyzeStoryChapters({ segments, model: this.selectedOllamaModel });
      this.splitChapters = (res.chapters || []).map(c => ({
        index: c.index, startSeconds: c.startSeconds, endSeconds: c.endSeconds,
        label: cleanChapterLabel(c.label),
        subChapters: toStoryChapters(c.subChapters),
      }));
      if (this.splitChapters.length === 0) throw new Error('No chapters detected.');
      // No pre-selection — the user chooses which chapters go into which story (unassigned = scrap).
      this.splitAssign = this.splitChapters.map(() => -1);
      this.splitBuckets = [{ title: story.title }];        // fresh analysis → fresh layout
      this.splitAnalyzedRegions = regions;
      this.persistSplitCache();                            // cache so a reopen is instant/reworkable
    } catch (err: any) {
      // A stop leaves the dialog idle (its Start button back), not showing a failure.
      this.splitError = this.isStopError(err) ? null : (err?.message || String(err));
    } finally {
      this.splitRunning = false;
      this.analyzeStopRequested = false;
      this.cdr.detectChanges();
    }
  }

  /** Human-readable coverage summary for the detected chapters (count + the span they tile). Makes
   *  it obvious when a model under-segments into one giant chapter vs. genuinely missing coverage. */
  get splitCoverage(): string {
    if (!this.splitChapters.length) return '';
    const start = this.splitChapters[0].startSeconds;
    const end = this.splitChapters[this.splitChapters.length - 1].endSeconds;
    const n = this.splitChapters.length;
    return `${n} chapter${n > 1 ? 's' : ''} · covers ${this.chapterClock(start)}–${this.chapterClock(end)}`;
  }

  setSplitActiveBucket(i: number): void { this.splitActiveBucket = i; }

  addSplitBucket(): void {
    this.splitBuckets.push({ title: `Story ${this.stories.length + this.splitBuckets.length}` });
    this.splitActiveBucket = this.splitBuckets.length - 1;
  }

  removeSplitBucket(i: number): void {
    if (i === 0) return;   // bucket 0 is the original story — never removed
    this.splitAssign = this.splitAssign.map(b => (b === i ? -1 : (b > i ? b - 1 : b)));
    this.splitBuckets.splice(i, 1);
    if (this.splitActiveBucket >= this.splitBuckets.length) this.splitActiveBucket = 0;
  }

  onSplitBucketTitle(i: number, value: string): void {
    if (!this.splitBuckets[i]) return;
    this.splitBuckets[i].title = value;
    // A name typed here is a name the user chose, exactly like one typed in the story list — it
    // rides onto the resulting story as `titleTouched` so auto-titling leaves it alone.
    this.splitBuckets[i].touched = true;
  }

  /** Assign a chapter to the active bucket; re-click with the same active bucket excludes it (scrap). */
  clickSplitChapter(i: number): void {
    this.splitAssign[i] = this.splitAssign[i] === this.splitActiveBucket ? -1 : this.splitActiveBucket;
  }

  /** Preview color for a split bucket (bucket 0 = the original story's number; others preview
   *  the numbers they'll receive). */
  splitBucketColor(i: number): string {
    const n = i === 0 ? (this.splitStory?.number || 1) : (this.stories.length + i);
    return this.storyColor(n);
  }

  splitBucketCount(i: number): number { return this.splitAssign.filter(b => b === i).length; }
  get splitScrapCount(): number { return this.splitAssign.filter(b => b === -1).length; }
  /** True once at least one chapter is assigned to a story — gates Apply so a bare confirm can't
   *  silently empty the story (everything left as scrap). */
  get splitAnyAssigned(): boolean { return this.splitAssign.some(b => b >= 0); }

  /**
   * STORY-LOCAL time of an ORIGINAL-second position: how far into the story's OWN content the
   * position sits, i.e. the sum of the story's earlier regions' edited durations plus the edited
   * offset within the region that contains it. This is where the moment lands in Final Cut Pro
   * once the between-region content (and any cuts) is removed — so a story that sits 3 hours deep
   * in the livestream but is only an hour of real content reads 0:00 … 1:00:00, not livestream time.
   */
  private storyLocalTime(originalSeconds: number, regions: { start: number; end: number }[]): number {
    const sorted = [...regions].sort((a, b) => a.start - b.start);
    let acc = 0;
    for (const r of sorted) {
      // Per-piece sums, so a region whose footage a reorder scattered still reports its real
      // length instead of collapsing to 0 on a backwards end-minus-start.
      const pieces = this.editedRangesForOriginal(r.start, r.end);
      if (originalSeconds <= r.start + EPS) return acc;                 // before this region
      if (originalSeconds <= r.end + EPS) {                             // inside this region
        // Content of the region that precedes `originalSeconds` IN ORIGINAL TIME. Story-local
        // time is a chapter clock for the exported project, which lays a story's regions out in
        // original order — it deliberately does not follow a within-region reorder.
        let inner = 0;
        for (const p of this.editedRangesForOriginal(r.start, Math.min(r.end, originalSeconds))) {
          inner += p.hi - p.lo;
        }
        return acc + inner;
      }
      for (const p of pieces) acc += p.hi - p.lo;
    }
    return acc;   // at/after the last region → the story's full length
  }

  /** Story-local clock for a chapter boundary in the open Split modal (relative to the split
   *  story's own content, excluding between-region gaps — matching the FCP output). */
  chapterClock(originalSeconds: number): string {
    const regions = this.splitStory ? mergeRegions(this.splitStory.regions) : [];
    return fmtClock(this.storyLocalTime(originalSeconds, regions));
  }

  /**
   * Apply the split: rewrite the original story from bucket 0 and create a new story per other
   * non-empty bucket. Each chapter's span is intersected with the story's ORIGINAL regions so
   * the story's gaps are preserved (a story can be split across locations).
   */
  confirmSplit(): void {
    const story = this.splitStory;
    if (!story) { this.cancelSplit(); return; }
    // Intersect against the ANALYZED span, not the story's current regions: on a rework the story
    // was already shrunk by a prior Apply, but the chapters still address the original span.
    const basis = this.splitAnalyzedRegions.length ? this.splitAnalyzedRegions : mergeRegions(story.regions);
    // Remove the stories the previous Apply of THIS split created, so a rework replaces rather
    // than duplicates them (missing ids — a child the user already deleted — are simply skipped).
    const oldChildIds = story.split?.childIds || [];
    if (oldChildIds.length) {
      this.stories = this.stories.filter(s => s.id === story.id || !oldChildIds.includes(s.id));
    }
    const bucketRegions: { start: number; end: number }[][] = this.splitBuckets.map(() => []);
    // Each bucket also collects the fine tier of every chapter assigned to it, so a story built out
    // of several chapters keeps all their markers.
    const bucketChapters: StoryChapter[][] = this.splitBuckets.map(() => []);
    this.splitChapters.forEach((ch, idx) => {
      const b = this.splitAssign[idx];
      if (b < 0) return;   // excluded (scrap)
      for (const r of basis) {
        const lo = Math.max(r.start, ch.startSeconds);
        const hi = Math.min(r.end, ch.endSeconds);
        if (hi - lo > EPS) bucketRegions[b].push({ start: lo, end: hi });
      }
      if (ch.subChapters?.length) bucketChapters[b].push(...ch.subChapters);
    });
    // Bucket 0 rewrites the original story (empty ⇒ it keeps nothing, shown as empty).
    story.regions = mergeRegions(bucketRegions[0]);
    // PROVISIONAL (no fingerprint): these markers were cut for the PARENT story's span at the
    // parent's cadence, then clipped to whatever this bucket kept. They describe the content
    // honestly, but a story half the size wants roughly twice as many, so run 2 re-derives.
    setStoryChapters(story, clipStoryChapters(bucketChapters[0], story.regions), null);
    if (this.splitBuckets[0].title.trim()) {
      story.title = this.splitBuckets[0].title.trim();
      if (this.splitBuckets[0].touched) story.titleTouched = true;
    }
    // Other non-empty buckets become new stories, inserted right after the original.
    const newStories: Story[] = [];
    const childIds: string[] = [];
    for (let i = 1; i < this.splitBuckets.length; i++) {
      const regions = mergeRegions(bucketRegions[i]);
      if (regions.length === 0) continue;
      const id = `story-${++this.storyIdCounter}`;
      const child: Story = {
        id, number: 0, title: this.splitBuckets[i].title.trim() || 'Story', regions,
        ...(this.splitBuckets[i].touched ? { titleTouched: true } : {}),
      };
      setStoryChapters(child, clipStoryChapters(bucketChapters[i], regions), null);
      newStories.push(child);
      childIds.push(id);
    }
    if (newStories.length) {
      const at = this.stories.findIndex(s => s.id === story.id);
      this.stories.splice(at + 1, 0, ...newStories);
    }
    this.persistSplitCache(childIds);   // remember analysis + layout + the children this Apply made
    this.renumberStories();
    this.storySelection = null;
    this.scheduleEditsSave();
    this.requestRender();
    this.closeSplitModal();
  }

  /** Cancel/close: keeps the story's cached analysis (so a reopen is still instant) and remembers
   *  the in-progress layout, but applies no region changes. */
  cancelSplit(): void {
    // Closing while a detection runs stops it. Without this the run is orphaned — the dialog goes
    // away but hundreds of model calls keep going in the main process with nowhere to land.
    if (this.splitRunning) void this.stopAnalysis();
    if (this.splitStory && this.splitChapters.length && !this.splitRunning) this.persistSplitCache();
    this.closeSplitModal();
  }

  /** Reset the modal's transient state without touching the story's persisted split cache. */
  private closeSplitModal(): void {
    this.splitModalOpen = false;
    this.splitStory = null;
    this.splitChapters = [];
    this.splitAssign = [];
    this.splitBuckets = [];
    this.splitAnalyzedRegions = [];
    this.splitActiveBucket = 0;
    this.splitFromCache = false;
    this.splitError = null;
    this.splitRunning = false;
    this.cdr.detectChanges();
  }

  // ── Top-bar File menu ────────────────────────────────────────────────────────
  /** Toggle the File menu dropdown. */
  toggleMenu(): void { this.menuOpen = !this.menuOpen; }

  /** File ▸ Export…: open the chooser modal. */
  onExportFromMenu(): void {
    this.openExportChooser();
  }

  /** File ▸ Open…: close the menu and run the existing project picker. */
  onOpenFromMenu(): void {
    this.menuOpen = false;
    void this.pickProject();
  }

  /** Friendly DISPLAY name for a track/speaker id — template-callable delegate (see
   *  model/editor-format.ts for the rules). */
  prettyLabel(raw: string): string {
    return prettyLabel(raw);
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
      kept.push({ zipPath: this.currentZipPath, name: deriveName(this.currentZipPath), lastOpened: new Date().toISOString() });
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
    const entry: RecentSession = { zipPath, name: deriveName(zipPath), lastOpened: new Date().toISOString() };
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
    // Same-path click is a no-op — unless the last load FAILED, where it means "retry".
    if (r.zipPath === this.currentZipPath && !this.errorMessage) return;
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

  // ── Projects sidebar (registry-backed; the pane's list) ─────────────────────
  /**
   * A processed/edited project was clicked → load it into THIS window through the one
   * sanctioned session-switch path. A project the scanner called openable but that carries no
   * zip is a contradiction: it is reported in the pane rather than opening nothing. Not fail(),
   * which would tear down the session already loaded here over another project's bad row.
   */
  onProjectOpen(entry: ProjectEntry): void {
    const zipPath = entry.scan?.zipPath;
    if (!zipPath) {
      this.projectSidebar?.showError(
        `“${entry.name}” is marked ${entry.scan?.state || 'unknown'} but has no session zip on disk.`
      );
      return;
    }
    // Same-path click is a no-op — unless the last load FAILED, where it means "retry".
    if (zipPath === this.currentZipPath && !this.errorMessage) return;
    void this.bootstrap(zipPath);                // bootstrap() records it as opened
  }

  /**
   * A raw project was clicked → open the setup modal on it. Clicking the one whose job is
   * already running reopens the modal ONTO that run (live progress) rather than a fresh setup
   * form. A raw project with no master video is a contradiction the scanner should never
   * produce; it is reported in the pane rather than opening an empty modal.
   */
  onProjectProcess(entry: ProjectEntry): void {
    if (!entry.scan?.masterVideo) {
      this.projectSidebar?.showError(
        `“${entry.name}” is marked ${entry.scan?.state || 'unknown'} but has no master video on disk.`
      );
      return;
    }
    this.setupAttachRunning = this.processingEntryPath === entry.path;
    this.setupEntry = entry;
  }

  /** The modal started a run — record which project owns it and light the pane's row up. */
  onProjectSetupStarted(): void {
    if (!this.setupEntry) return;
    this.processingEntryPath = this.setupEntry.path;
    this.projectBusyPath = this.setupEntry.path;
    this.projectBusyPercent = 0;
  }

  /** Dismissed. A run in flight is untouched — it keeps going and the pane keeps showing it. */
  onProjectSetupClosed(): void {
    this.setupEntry = null;
    this.setupAttachRunning = false;
  }

  /**
   * A run finished and produced a session: refresh that project's scan (it is no longer raw),
   * stamp it as opened, and load it into this window through the one sanctioned path.
   */
  async onProjectSetupCompleted(result: { zipPath: string }): Promise<void> {
    const entry = this.setupEntry;
    this.setupEntry = null;
    this.setupAttachRunning = false;
    this.processingEntryPath = null;
    this.projectBusyPath = null;
    this.projectBusyPercent = null;
    if (entry) {
      try {
        await this.projectsService.rescan(entry.path);
        await this.projectsService.markOpened(entry.path);
      } catch (err: any) {
        // The session still exists and is still openable — say what didn't get recorded
        // instead of failing the open over a list bookkeeping error.
        this.projectSidebar?.showError(
          `Processed “${entry.name}”, but the projects list could not be updated: ${err?.message || String(err)}`
        );
      }
    }
    await this.bootstrap(result.zipPath);
  }

  /** Job → pane busy row. Only a job this window attributed to a project is shown there. */
  private onProcessingJob(job: ProcessingJob | null): void {
    const owner = this.processingEntryPath;
    if (!owner) return;
    if (job && job.status === 'running') {
      this.projectBusyPath = owner;
      this.projectBusyPercent = job.progress;
    } else {
      // Terminal (or cleared): the row goes back to its scanned state. A completed run also
      // clears through onProjectSetupCompleted, whichever lands first. If the modal was
      // closed mid-run, this is the only place that learns the run ended — rescan so the
      // row's badge reflects what is now on disk instead of the stale pre-run state.
      this.projectBusyPath = null;
      this.projectBusyPercent = null;
      this.processingEntryPath = null;
      if (job && (job.status === 'completed' || job.status === 'error')) {
        this.projectsService.rescan(owner).catch((err: any) => {
          this.projectSidebar?.showError(
            `Could not refresh “${owner}” after its run ended: ${err?.message || String(err)}`);
        });
      }
    }
    this.cdr.detectChanges();
  }

  /** File ▸ Add Project…: same flow as the pane's + button, errors landing in the same place. */
  onAddProjectFromMenu(): void {
    this.menuOpen = false;
    if (!this.projectSidebar) {
      // Unreachable by construction: the pane and the File menu render under the same *ngIf.
      console.error('[editor] File ▸ Add Project… fired with no projects pane mounted');
      return;
    }
    void this.projectSidebar.onAdd();
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
      // A group's edited span is its OUTER extent across surviving pieces. In source order that is
      // the old O2E(start)/O2E(end) pair exactly; a reorder that splits a group (possible when the
      // drop edge falls inside its clip on another track) leaves the karaoke highlight following
      // the group's first piece, which is where the line starts reading.
      const pieces = this.editedRangesForOriginal(g.originalStart, g.originalEnd);
      if (pieces.length === 0) continue;
      const editedStart = pieces[0].lo;
      out.push({
        label: g.label,
        color: g.color,
        text: g.text,
        originalStart: g.originalStart,
        originalEnd: g.originalEnd,
        editedStart,
        editedEnd: pieces[pieces.length - 1].hi,
        timecode: formatTimecode(editedStart, this.manifest?.frameSeconds || (1001 / 30000)),
      });
    }
    // updateActiveGroup() walks this list assuming ascending editedStart and BREAKS at the first
    // line past the playhead — transcriptGroups is in original order, which stops being edited
    // order the moment footage moves, and an unsorted list would freeze the karaoke highlight.
    // Stable no-op in source order.
    out.sort((a, b) => a.editedStart - b.editedStart);
    this.visibleGroups = out;
    // The list (and its indices) just changed — re-resolve which line the playhead sits in.
    this.updateActiveGroup(false);
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
      if (g.originalStart >= cs - EPS && g.originalEnd <= ce + EPS) return true;
    }
    return false;
  }

  /** Start (or restart) the transcription job for the current session. */
  async startTranscription(): Promise<void> {
    if (!this.currentZipPath) return;
    this.transcriptState = 'running';
    this.activityOpen = true;   // surface the background dock so progress is visible
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
    // One piece in source order → the old single selStart/selEnd range. Several (a reorder split
    // the group's clip) → the multi-range form, so the highlight covers all of its footage
    // instead of a span running backwards through unrelated material.
    const pieces = this.editedRangesForOriginal(g.originalStart, g.originalEnd);
    this.selectedRanges = [];        // the group replaces any marquee selection
    this.selStart = null;
    this.selEnd = null;
    if (pieces.length === 1) {
      if (pieces[0].hi - pieces[0].lo > EPS) {
        this.selStart = pieces[0].lo;
        this.selEnd = pieces[0].hi;
      }
    } else if (pieces.length > 1) {
      this.selectedRanges = pieces.map(p => ({ start: p.lo, end: p.hi }));
    }
    this.selectedGroupStart = g.originalStart;
    this.selectedGroupEnd = g.originalEnd;
    this.setPlayhead(pieces.length > 0 ? pieces[0].lo : g.editedStart);
    this.ensureSelectionVisible();
  }

  /** True when a rendered group is the one currently reflected in the timeline selection. */
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

  /**
   * Resolve which transcript line the playhead sits in and, while playing, keep it scrolled
   * into view (karaoke follow). visibleGroups is in ascending edited-time order, so the active
   * line is the last one whose editedStart is at/before the playhead. `allowScroll` is false for
   * pure re-index passes (e.g. a filter change) so we never yank the list while the user reads.
   */
  private updateActiveGroup(allowScroll: boolean): void {
    const t = this.playheadTime;
    let idx = -1;
    const groups = this.visibleGroups;
    for (let i = 0; i < groups.length; i++) {
      if (groups[i].editedStart <= t + EPS) idx = i;
      else break;
    }
    if (idx !== this.activeGroupIdx) {
      this.activeGroupIdx = idx;
    }
    // Only chase the highlight down the list during playback, and only when it actually moved.
    if (allowScroll && this.isPlaying && idx >= 0 && idx !== this.lastScrolledGroupIdx) {
      this.lastScrolledGroupIdx = idx;
      this.transcriptPane?.scrollGroupIntoView(idx);
    }
  }

  // ── Activity window (background-task HUD) ───────────────────────────────────
  // Template-callable delegates onto the waveform cache (the dock's waveform block binds all
  // four). strictTemplates cannot reach through a private field.
  /** Waveform peaks are still being extracted (queued or running ffmpeg). */
  get waveformActive(): boolean { return this.waveforms.active; }

  /** Determinate % for the current waveform-extraction burst (0 when idle). */
  get waveformPct(): number { return this.waveforms.pct; }

  get peaksBurstDone(): number { return this.waveforms.burstDone; }
  get peaksBurstTotal(): number { return this.waveforms.burstTotal; }

  /** Anything worth a spinner: transcription, export, waveform, or story analysis in flight. */
  get hasBackgroundActivity(): boolean {
    return this.transcriptState === 'running' || this.exporting || this.waveformActive || this.analyzing;
  }

  /** The waiting rows rendered under it, capped at what the dock can show. */
  get activityPending(): ActivityEntry[] {
    return this.activityQueue.filter(e => e.state === 'pending').slice(0, this.ACTIVITY_PENDING_SHOWN);
  }

  /** How many queued stories are beyond the shown rows — the "+N more" line. */
  get activityPendingMore(): number {
    return Math.max(0, this.activityQueue.filter(e => e.state === 'pending').length - this.ACTIVITY_PENDING_SHOWN);
  }

  /** Seed the queue for a run. The first entry is running; the rest wait in run order. */
  private activityQueueStart(entries: { id: string; label: string }[]): void {
    this.activityQueue = entries.map((e, i) => ({ ...e, state: i === 0 ? 'running' : 'pending' }));
    this.activitySkipRequested.clear();   // skips belong to the run they were made in
  }

  /**
   * X on a WAITING row: drop that one story from the run. The row disappears now; the loop
   * checks the skip set when it reaches the story and simply never runs it. Nothing is aborted —
   * the story wasn't running.
   */
  cancelPendingActivity(id: string): void {
    this.activitySkipRequested.add(id);
    this.activityQueue = this.activityQueue.filter(e => e.state === 'running' || e.id !== id);
  }

  /**
   * X on the RUNNING row's name: cancel just this story and let the run move on. Same abort as
   * the stop button — the difference is intent, recorded in the skip set BEFORE the abort so the
   * loop's catch can tell "skip this one" from "stop everything".
   */
  async skipRunningActivity(): Promise<void> {
    const head = this.activityQueue[0];
    if (!head) return;
    this.activitySkipRequested.add(head.id);
    try {
      await this.electron.cancelStoryAnalysis();
    } catch {
      // Nothing in flight — the loop-top check still skips it.
    }
  }

  /**
   * The current entry is finished with — done, or failed and skipped. It drops off the top and the
   * next one becomes running, which is exactly what the dock is meant to show.
   */
  private activityQueueAdvance(): void {
    this.activityQueue.shift();
    if (this.activityQueue.length) this.activityQueue[0].state = 'running';
  }

  toggleActivity(): void {
    this.activityOpen = !this.activityOpen;
  }

  // ── Playback (element-based jump-cuts) ──────────────────────────────────────
  // Variable-speed transport (FCPX-style JKL). L steps the speed UP through L_SPEEDS,
  // J steps it DOWN (slow) through J_SPEEDS, K/Space toggle play/pause. Pausing resets
  // to 1x. The rAF clock advances by elapsed*playbackRate; media elements mirror the rate.
  playbackRate = 1;
  private readonly L_SPEEDS = [1.5, 2, 2.5, 3];
  private readonly J_SPEEDS = [0.75, 0.66, 0.5, 0.25];

  togglePlayback(): void {
    if (this.isPlaying) this.stopPlayback();
    else this.startPlayback();
  }

  /** Push the current playbackRate onto the viewer video + every audio element. */
  private applyRateToElements(): void {
    const v = this.viewerVideoRef?.nativeElement;
    if (v) { try { v.playbackRate = this.playbackRate; } catch { /* not settable yet */ } }
    for (const el of this.audioEls.values()) {
      try { el.playbackRate = this.playbackRate; } catch { /* gone */ }
    }
  }

  /**
   * Set the playback speed, re-anchoring the timeline clock so the position stays
   * continuous across the change. Starts playback if paused.
   */
  private setPlaybackRate(rate: number): void {
    if (!this.manifest) return;
    if (!this.isPlaying) {
      this.startPlayback();                 // anchors at the playhead, rate reset to 1
    } else {
      this.playAnchorTime = this.playheadTime;
      this.playAnchorPerfMs = performance.now();
    }
    this.playbackRate = rate;
    this.applyRateToElements();
    this.cdr.detectChanges();
  }

  /** L: step the speed up (1.5 → 2 → 2.5 → 3), jumping onto the fast ladder from any state. */
  private cycleSpeedUp(): void {
    const i = this.L_SPEEDS.indexOf(this.playbackRate);
    const next = i >= 0 ? this.L_SPEEDS[Math.min(i + 1, this.L_SPEEDS.length - 1)] : this.L_SPEEDS[0];
    this.setPlaybackRate(next);
  }

  /** J: step the speed down (0.75 → 0.66 → 0.5 → 0.25), jumping onto the slow ladder. */
  private cycleSpeedDown(): void {
    const i = this.J_SPEEDS.indexOf(this.playbackRate);
    const next = i >= 0 ? this.J_SPEEDS[Math.min(i + 1, this.J_SPEEDS.length - 1)] : this.J_SPEEDS[0];
    this.setPlaybackRate(next);
  }

  private startPlayback(): void {
    if (!this.manifest) return;
    this.transportError = '';
    // Starting at (or past) the end restarts from the top.
    if (this.playheadTime >= this.editedDuration - 1e-3) {
      this.playheadTime = 0;
    }
    this.isPlaying = true;
    this.playbackRate = 1;            // plain play/K/Space always starts at normal speed
    this.applyRateToElements();
    this.playAnchorPerfMs = performance.now();
    this.playAnchorTime = this.playheadTime;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = requestAnimationFrame(this.tick);
  }

  private stopPlayback(): void {
    this.isPlaying = false;
    this.playbackRate = 1;            // pausing resets the speed (next play is 1x)
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    const v = this.viewerVideoRef?.nativeElement;
    if (v) { try { v.pause(); } catch { /* already paused */ } }
    for (const el of this.audioEls.values()) { try { el.pause(); } catch { /* gone */ } }
  }

  /** rAF loop: advance the timeline clock off performance.now() and sync every element. */
  private tick = (): void => {
    if (!this.isPlaying || !this.manifest) { this.rafId = null; return; }
    const elapsed = (performance.now() - this.playAnchorPerfMs) / 1000;
    let t = this.playAnchorTime + elapsed * this.playbackRate;
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
    this.updateActiveGroup(true);   // karaoke: advance + scroll the transcript highlight
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
      v.src = pathToFileUrl(seg.file);
      this.viewerLoadedFile = seg.file;
      try { v.playbackRate = this.playbackRate; } catch { /* set on play */ }
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
    el.src = pathToFileUrl(file);
    try { el.playbackRate = this.playbackRate; } catch { /* set on play */ }
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
