# Editor decomposition plan

Written 2026-08-07 (Opus planning pass over the full 5,783-line component).
Goal: split `frontend/src/app/components/editor/editor.component.ts` (+ its
`.html` ~630 lines and `.scss`) into child components and pure modules, leaving
the shell as session bootstrap + layout + edit model + wiring. **Behavior must
be byte-identical — mechanical decomposition, not redesign.**

Status legend: each step gets ✅ + commit hash when landed. Run the §6 checklist
after every step, no exceptions.

---

## 0. Ground truth corrections (verified against source)

- **The window mousemove/mouseup listeners are NOT registered in `ngOnInit`.**
  They are added lazily at the start of each gesture (`onCanvasMouseDown`,
  `onSplitVMouseDown`, `onSplitHMouseDown`, `onSplitPMouseDown`,
  `onScrollbarThumbMouseDown`, `onActivityDragStart`) and removed in
  `onWindowMouseUp` / `onActivityDragEnd`. `ngOnDestroy` removes all four
  defensively. What `ngOnInit` registers permanently: `electron.onEditorPayload`,
  `onTranscribeProgress`, `onTranscribeComplete`, `onStoryAnalyzeProgress`, and
  the `processing.getCurrentJob()` subscription.
- **`onWindowMouseMove` is a single dispatcher shared by nine drag modes**
  (`draggingStoryEdge`, `moveDrag`, `draggingSelection`, `marqueeActive`,
  `draggingPlayhead`, `draggingScrollbar`, `draggingSplitV/H/P`). This is the
  single biggest reason the timeline cannot be split off cleanly — see §4.
- **`storyAtEdited` (lines 4215–4226) is dead code** — the only other occurrence
  of the name is a doc comment on `storyRegionAtEdited`. Free deletion in step 1.
- **`Cut`, `Story`, `StoryChapter` are exported but imported nowhere** — moving
  the types out is free.
- **`.modal-backdrop` (SCSS 532–684) is shared by three modals** — export
  chooser, export result, and the split modal. Under emulated encapsulation this
  is the exact `.pp-*` trap from the sidebar extraction. Shared-partial rule in §1.

---

## 1. Target architecture

```
components/editor/
  editor.component.ts            ← shell: session bootstrap, layout, edit model, wiring
  editor.component.html
  editor.component.scss

  model/
    editor-types.ts              interfaces + type aliases only, no logic
    editor-math.ts               EPS + pure interval/array math
    editor-format.ts             pure string/number formatting
    story-utils.ts               pure story-shape helpers
    transcript-segments.ts       pure words → analyzer segments
    edited-time-map.ts           the narrow read-only interface children accept

  timeline/
    timeline-metrics.ts          FCP visual constants (px)
    timeline-scene.ts            the readonly struct the renderer draws
    timeline-renderer.ts         all canvas drawing (no Angular, no DOM refs)
    waveform-cache.ts            peaks cache + ffmpeg queue + burst counters

  activity-dock/                 app-editor-activity-dock
  export-modals/                 app-editor-export-modals
  transcript-pane/               app-transcript-pane
  viewer-pane/                   app-editor-viewer
  story-list/                    app-story-list
  story-split-modal/             app-story-split-modal
  topbar/                        app-editor-topbar

  services/
    story-analysis.service.ts    Ollama calls + model choice + stop/cancel semantics

  styles/
    _modal.scss                  .modal-backdrop / .modal / .modal-btn / .modal-actions
```

### Where state lives

**The shell owns every piece of mutable editing state**, without exception:
`manifest`, `cuts`, `sequence`, `keptBySequence`/`keptByOriginal`, `segsByTrack`,
`editedDuration`, `snapPoints`, `bladeBoundaries`, `playheadTime`, `pxPerSec`,
`scrollOffset`, all selection fields, `stories`, `undoStack`/`redoStack`,
`toolMode`, the transcript data, the export flags, the activity queue, and the
split ratios. It is the only thing that calls `rebuildEditedModel()`,
`requestRender()`, `scheduleEditsSave()`, `setPlayhead()`, and
`cdr.detectChanges()` for cross-pane effects.

**Children are presentational.** Data down as `@Input()`, intent up as
`@Output()`. No child calls `bootstrap`, `rebuildEditedModel`, or
`scheduleEditsSave`.

**One deliberate exception, and it is not a global state service:**

```ts
// model/edited-time-map.ts
export interface EditedTimeMap {
  readonly editedDuration: number;
  originalToEdited(t: number): number;
  editedToOriginal(e: number): number;
  editedRangesForOriginal(start: number, end: number): { lo: number; hi: number }[];
}
```

`EditorComponent implements EditedTimeMap` (the four members become `public`),
and passes `this` as `[timeMap]="this"` to the two children that genuinely need
original↔edited projection: the story list (`storyDuration`) and the split modal
(`chapterClock` → `storyLocalTime`). Not a service: the maps are derived from
this shell's `keptBy*` arrays, rebuilt per session; a narrow read-only interface
passed as one Input keeps the coupling visible in the template and keeps the
editor liftable into Content Studio (the interface has no AutoCutStudio
dependency).

**In-place mutation is preserved where it exists today.** The story list
receives `Story` objects by reference and mutates `story.title` /
`story.regions` exactly as the current code does, then emits `(changed)` so the
shell runs `scheduleEditsSave(); requestRender(); cdr.detectChanges();` in the
same order. The `titleTouched` flag, the merge-pick set and the ribbon all read
the same object identities — immutable re-plumbing would not be byte-identical.

**SCSS rule for every step:** the block's *own* properties go on `:host` in the
child stylesheet; the nested rules move verbatim, de-indented one level. Any
rule shared with a block that stays behind (`.modal-backdrop`, `.modal-btn`)
goes into `styles/_modal.scss` and is pulled in with
`@use '../styles/modal' as *;` — never duplicated, never left in the parent
hoping it will reach.

---

## 2. Ordered extraction steps

Every step ends with the checklist in §6. Each is independently shippable.

### Step 1 — `model/editor-types.ts` + dead-code removal

No new component. No template or SCSS change.

**Moves out of `editor.component.ts` (lines 26–227):** `Peaks`,
`TranscriptWord`, `TranscriptTrack`, `Transcript`, `TranscriptGroup`,
`TranscriptGroupView`, `TranscriptState`, `RecentSession`, `ToolMode`, `Cut`,
`Story`, `StoryChapter`, `StorySplitCache`, `KeptInterval`, `EditSnapshot`,
`ActivityEntry`, `TrackRow`.

**Add one new named type** (needed once `drawMoveInsertion` leaves the class in
step 6 — it currently types its argument as
`NonNullable<EditorComponent['moveDrag']>`, an indexed access on a private field):

```ts
export interface MoveDrag {
  ranges: { lo: number; hi: number }[];
  grabTime: number;
  dropAt: number;
  boundaries: number[];
  moved: boolean;
}
```
Retype the field to `private moveDrag: MoveDrag | null = null;` and
`moveLandingTime(d: MoveDrag)`.

**Delete:** `storyAtEdited` (4215–4226) — provably unreachable.

**Keep every doc comment with its type** (the `Story.chaptersFrom` and
`KeptInterval` comments are load-bearing).

**Hazards:** `EDITS_SCHEMA_VERSION` is `private static readonly` on the class,
referenced as `EditorComponent.EDITS_SCHEMA_VERSION` in two places — leave it on
the class. `isolatedModules: true` — use `export type` / `import type` where
required.

Yield: ~205 lines.

### Step 2 — `model/editor-math.ts`, `model/editor-format.ts`, `model/story-utils.ts`

No new component. No template change.

**`editor-math.ts`** — `export const EPS = 1e-9;` plus, converted from methods
to free functions (each reads only `this.EPS` today, verified):
`mergeRanges` (1491–1502), `mergeRegions` (3204–3219), `mergeCuts` (2785–2799),
`nearestBoundary` (2208–2218), `normalizeSequence` (2337–2351, gains the
duration parameter it currently reads off `this.manifest`), `segmentAtIn`
(body of `segmentAt` 1265–1283; shell keeps `private segmentAt(trackId, t)` as
a one-line delegate), `isMultiPick` (3504–3506), `isTypingTarget` (2767–2772).
Then replace **every** `this.EPS` in the shell with imported `EPS` (~60 sites,
one commit, never half-converted).

**`editor-format.ts`** — `pad2` (1835), `formatTimecode` (1940–1950, gains a
`frameSeconds` param; **keep the `1001/30000` fallback at the call sites**, not
in the function), `formatRulerLabel` (1837–1843), `fmtClock` (4748–4754),
`prettyLabel` (4959–4968), `cleanChapterLabel` (4839–4842), `pathToFileUrl`
(1957–1959), `deriveName` (4989–4993) + `export const COMPOUNDS_SUFFIX`,
`chooseTickStep` (1826–1833).

**`story-utils.ts`** — `STORY_COLORS` (470), `storyColor` (3300–3304),
`storiesForDisplay` (3192–3197), `isStoryEmpty` (3222–3224),
`regionFingerprint` (3246–3250), `storyChapterState` (3262–3266),
`storyApproxChapters` (3274–3276), `setStoryChapters` (3288–3297),
`toStoryChapters` (4799–4808), `clipStoryChapters` (4815–4835).

**What stays:** thin public delegating methods for anything the shell's own
template reads (`strictTemplates` — a template cannot call an imported
function): `prettyLabel`, `storyColor`, and the template-called
`storyChapterState` / `storyApproxChapters` / `isStoryEmpty`
(`[ngSwitch]`, `*ngIf ... as n` sites) — delegate, don't delete.

Yield: ~180 lines; unblocks every later step.

### Step 3 — `activity-dock/` → `app-editor-activity-dock`

**Template moves:** HTML 166–235 (whole `.activity-window`), replaced by
`<app-editor-activity-dock *ngIf="activityOpen" …>` — keep the `*ngIf` on the
host in the same DOM position (inside `.editor`, do not hoist).

**SCSS moves:** `@keyframes activity-spin` (1398–1404), `.activity-window`
(1405–1589), `@keyframes activity-sweep` (1590–1594), `.activity-error`
(1601–1609 — top-level selector today but rendered inside the dock; it must
move or it silently stops applying). Own props (`position: fixed; top: 78px;
left: 50%; z-index: 200; width; background; border; border-radius; box-shadow;
overflow`) go on `:host`; `[style.transform]` becomes
`@HostBinding('style.transform')` computed from `x`/`y` inputs.
**Do NOT move `.pane-activity-btn`** — it stays with `.pane-tabs`.

**TS moves:** `onActivityDragStart` (5575–5581), `onActivityDragMove`,
`onActivityDragEnd`, `private activityDragBase`. Nothing else.

**Contract:**
```ts
@Input() x = 0; @Input() y = 0;
@Input() transcribing = false;      // transcriptState === 'running'
@Input() transcribeProgress = 0; @Input() transcribeMessage = '';
@Input() transcribeEtaLabel = '';
@Input() exporting = false;
@Input() waveformActive = false; @Input() waveformPct = 0;
@Input() peaksBurstDone = 0; @Input() peaksBurstTotal = 0;
@Input() analyzing = false; @Input() analyzeMessage = '';
@Input() analyzeError: string | null = null;
@Input() aiPhase = ''; @Input() aiProgressTotal = 0; @Input() aiProgressPct = 0;
@Input() queue: ActivityEntry[] = []; @Input() pending: ActivityEntry[] = [];
@Input() pendingMore = 0; @Input() hasBackgroundActivity = false;
@Output() closed; @Output() moved: EventEmitter<{x: number; y: number}>;
@Output() stopRequested; @Output() skipRunningRequested;
@Output() cancelPendingRequested: EventEmitter<string>;
```
Child computes `get running() { return this.queue[0] ?? null; }` (=== `activityRunning`).

**Stays in shell (why):** `activityOpen` (written from six places),
`activityX`/`activityY` (must survive close→reopen — Inputs + `(moved)`; if the
child owned them a reopen would recenter the dock), the queue itself
(`activityQueue`, `activityQueueStart`, `activityQueueAdvance`,
`activitySkipRequested`, `ACTIVITY_PENDING_SHOWN`, `activityRunning`,
`activityPending`, `activityPendingMore`), `cancelPendingActivity`,
`skipRunningActivity`, `stopAnalysis`, `waveformActive`/`waveformPct`.

**Hazards:** child adds window mousemove/mouseup in `onActivityDragStart`, must
remove them in **both** `onActivityDragEnd` and its own `ngOnDestroy` (child can
die mid-drag via `resetSessionState`); shell's ngOnDestroy lines for these are
then deleted. Current drag handler calls **no** `cdr.detectChanges()` (zone
patching covers it) — do not add one. No `OnPush` anywhere — do not introduce it.

Yield: ~70 HTML, ~200 SCSS, ~20 TS.

### Step 4 — `export-modals/` → `app-editor-export-modals` + `styles/_modal.scss`

**First create `styles/_modal.scss`** from SCSS 532–684: `.modal-backdrop`,
`.modal` (own props + `.modal-title`, `.modal-actions`, `.modal-btn`,
`&.error .modal-title`). Export-specific children (`.chooser-options`,
`.chooser-opt*`, `.chooser-toggle*`, `.modal-path`, `.modal-note`,
`.modal-error`) go in the child's stylesheet. `@use` from export-modals now and
story-split-modal in step 10. Delete 532–684 from the shell.

**Template moves:** HTML 76–126 (export chooser) + 128–155 (result/error
modal) → one child at line 76.

**TS moves:** dismissal wiring only; `onExportChoice` (3067–3070),
`onShowExport` (3154–3156), `closeExportModal` (3159–3163) stay as shell
methods bound to Outputs.

**Contract:**
```ts
@Input() chooserOpen = false;
@Input() resultPath: string | null = null;
@Input() error: string | null = null;
@Input() micMuteBlocks: number | null = null;
@Input() cutCount = 0; @Input() storyCount = 0; @Input() hasStories = false;
@Input() transcriptReady = false; @Input() canMuteMic = false;
@Input() muteMic = true;
@Output() muteMicChange: EventEmitter<boolean>;   // banana-box [(muteMic)]
@Output() chooserClosed; @Output() choice: EventEmitter<'fcpxml' | 'transcripts'>;
@Output() showInFolder; @Output() dismissed;
```

**Stays in shell:** `exporting`, `exportResultPath`, `exportError`,
`exportMicMuteBlocks`, `exportChooserOpen`, `muteMicDuringScreen`, `canExport`,
`openExportChooser`, `toggleMuteMicDuringScreen`, `onExport`, `exportSequence`,
`removedSeconds`, `removedLabel`, and the Escape branch of `onKeyDown`
(2670–2676).

**Hazards:** the chooser checkbox is `[(ngModel)]="muteMicDuringScreen"` — same
state the top-bar toggle writes. Convert to `[(muteMic)]`; the shell's
`muteMicChange` handler must be a **bare assignment**, NOT
`toggleMuteMicDuringScreen()` — today checking the box does not call
`scheduleEditsSave()` (only the top-bar toggle does); preserve that asymmetry.
Backdrop semantics: chooser backdrop → `exportChooserOpen = false`; result
backdrop → `closeExportModal()`; inner card `$event.stopPropagation()`. Verbatim.

Yield: ~80 HTML, ~150 SCSS, ~10 TS.

### Step 5 — `timeline/waveform-cache.ts`

Plain class (not `@Injectable` — per-editor, takes callbacks):

```ts
export class WaveformCache {
  constructor(
    private extract: (o: { filePath: string; startSec: number; durationSec: number; buckets: number })
      => Promise<{ success?: boolean; min?: number[]; max?: number[]; error?: any }>,
    private onPeaksReady: () => void,   // === requestRender
  ) {}
  burstTotal = 0; burstDone = 0;
  get active(): boolean; get pct(): number;
  getOrRequest(seg: EditorSegment, onScreenW: number): Peaks | null;
  clear(): void;
}
```

**Moves:** `peaksCache`, `peaksInFlight`, `peaksActive`, `peaksQueue`,
`peaksBurstTotal`, `peaksBurstDone` (556–565); `BUCKETS_PER_PX`, `MAX_BUCKETS`,
`MIN_BUCKETS`, `MAX_CONCURRENT_PEAKS` (251–260); `peaksKey` (1736–1738),
`getOrRequestPeaks` (1740–1782), `pumpPeaksQueue` (1785–1794).
`MIN_WAVEFORM_PX` stays with the renderer (step 6).

**Stays:** `waveforms = new WaveformCache(o => this.electron.alignmentExtractPeaks(o), () => this.requestRender());`
plus one-line delegates for `waveformActive`, `waveformPct`, burst counters.

**Hazards:** `resetSessionState` (783–787) → `this.waveforms.clear()`; **must
not cancel in-flight promises** (today a landed extraction for the old session
writes into a cleared map — keep). The `console.error` on failed extraction
(1770, 1773) is deliberate non-fatal-but-loud; move verbatim, do not convert to
`transportError`. Burst-restart heuristic
(`peaksActive === 0 && peaksQueue.length === 0`) stays inside `getOrRequest`,
evaluated before the push.

Yield: ~85 lines.

### Step 6 — `timeline/timeline-metrics.ts` + `timeline-scene.ts` + `timeline-renderer.ts`

**Biggest line win. No component, no template, no SCSS change.**

**`timeline-metrics.ts`:** `GUTTER_W`, `RULER_H`, `RIBBON_H`, `VIDEO_TRACK_H`,
`AUDIO_TRACK_H`, `CLIP_INSET_Y`, `CLIP_RADIUS`, `MIN_WAVEFORM_PX`, `ZOOM_MAX`
(235–257 + 245). Shell keeps `readonly GUTTER_W = GUTTER_W;` (template binds
it), and keeps using the constants for hit-testing / `trackRows` — imported from
the same module. One home, no duplication.

**`timeline-scene.ts`:**
```ts
export interface TimelineScene {
  rows: TrackRow[];
  segsByTrack: ReadonlyMap<string, EditorSegment[]>;
  scrollOffset: number; pxPerSec: number;
  playheadTime: number;
  editedDuration: number;
  ribbonHeight: number;
  bladeEdited: number[];                          // already mapped through originalToEdited
  selectionRanges: { lo: number; hi: number }[];  // === allSelectionRanges()
  pendingMark: number | null;                     // selStart ?? selEnd, when no ranges
  marquee: { active: boolean; moved: boolean; start: number; end: number };
  moveDrag: MoveDrag | null;
  stories: { id: string; number: number; title: string; regions: {start:number;end:number}[] }[];
  storyRibbonPieces: (r: {start:number;end:number}) => { lo:number; hi:number }[];
  activeStoryId: string | null;
  mergePicked: ReadonlySet<string>;
  hasStories: boolean;
}
```

**`timeline-renderer.ts`** — plain class `TimelineRenderer` constructed with
`(peaks: (seg, onScreenW) => Peaks | null)`, exposing
`draw(canvas, scene): void`. Moves verbatim (only `this.X` → `scene.X` /
imported constants): `draw` (1292–1361), `drawSelection` (1367–1420),
`moveLandingTime` (1429–1433), `drawMoveInsertion` (1441–1471),
`drawClipPieces` (1574–1597), `roundRectPath` (1599–1608), `drawVideoClip`
(1610–1635), `drawAudioClip` (1637–1663), `drawClipLabel` (1665–1677),
`drawWaveInside` (1684–1734), `drawRuler` (1796–1823), `drawStoriesRibbon`
(1854–1915), `drawPlayhead` (1917–1936). Plus local `timeToX`/`xToTime` from
`scene.scrollOffset`/`scene.pxPerSec`.

**Stays:** `requestRender` (1286–1290); new `private draw()` =
`const c = this.canvasRef?.nativeElement; if (!c || !this.manifest) return; this.renderer.draw(c, this.buildScene());`.
`trackRows`, `trackStackHeight`, `trackTopOffset`, `ribbonHeight` stay (gutter
template). `timeToX`/`xToTime` stay too — hit-testing.

**Hazards:** `drawStoriesRibbon` calls `editedRangesForOriginal` inside the
per-region loop — `storyRibbonPieces` as a scene function keeps call count and
ordering; do not pre-flatten (`storiesForDisplay()` once per frame, in
`buildScene`). `drawSelection`'s empty-ranges fallback is
`selStart ?? selEnd ?? null` (line 1405), NOT `selRange()` — pass as
`pendingMark`. `drawWaveInside` returns early on
`onScreenW < MIN_WAVEFORM_PX` **before** requesting peaks (ffmpeg-storm guard —
keep ordering). `drawClipPieces` `GAP = 2` inset and `px1 - px0 <= 0.5`
collapse guard — diff the moved block, do not retype. dpr backing-store resize
(1299–1306) + `ctx.setTransform` stay first in `draw`. **Verify visually after
this step** — load a session with ≥2 stories, ≥1 cut, a blade, a marquee
selection; drag a selection to check the ghost.

Yield: ~660 lines. Highest yield-per-risk in the plan.

### Step 7 — `transcript-pane/` → `app-transcript-pane`

**Template moves:** HTML 478–543 — all four state blocks (`.tx-empty`,
`.tx-running`, `.tx-error-state`, `.tx-ready`) incl. `#txGroupsEl` →
`<app-transcript-pane *ngIf="!storyMode" …>`. The `transcriptState`
discrimination moves inside. `.pane-tabs` + the `.transcript-pane` wrapper
**stay in the shell** (Edit/Stories switch + activity button).

**SCSS moves:** everything nested in `.transcript-pane` from
`.tx-empty, .tx-running, .tx-error-state` (~778) through end of `.tx-ready`
(~1117). Child `:host`: `flex: 1 1 auto; min-height: 0; display: flex;
flex-direction: column;`. Leave `.transcript-pane` + `.pane-tabs` (706–777) in
the shell.

**TS moves:** `transcribeEtaLabel` (5377–5384), `isGroupSelected` (5432–5437),
`searchResultCount` (5452–5454), `scrollActiveGroupIntoView` (5481–5491),
`@ViewChild('txGroupsEl')`, public `prettyLabel` delegate. `setSourceFilter` /
`onSearchInput` / `clearSearch` become Output emissions (bodies stay in shell).

**Contract:**
```ts
@Input() state: TranscriptState = 'none';
@Input() error = ''; @Input() progress = 0; @Input() message = '';
@Input() etaSeconds: number | null = null;
@Input() tracks: { id: string; label: string }[] = [];
@Input() sourceFilter = 'merged'; @Input() searchQuery = '';
@Input() groups: TranscriptGroupView[] = [];
@Input() activeGroupIdx = -1;
@Input() selectedGroupStart: number | null = null;
@Input() selectedGroupEnd: number | null = null;
@Output() transcribeRequested; @Output() cancelRequested;
@Output() sourceFilterChanged: EventEmitter<string>;
@Output() searchChanged: EventEmitter<string>; @Output() searchCleared;
@Output() groupSelected: EventEmitter<TranscriptGroupView>;
scrollGroupIntoView(idx: number): void;   // called imperatively by the shell
```

**Stays in shell (non-negotiable):** all transcript data — `transcript`,
`transcriptGroups`, `visibleGroups`, `transcriptTracks`, `transcriptWordCount`,
`sourceFilter`, `searchQuery`, `activeGroupIdx`, `lastScrolledGroupIdx`,
`transcribeJobId`, `loadTranscriptForSession`, `ingestTranscript`,
`recomputeVisibleGroups`, `isGroupFullyCut`, `startTranscription`,
`cancelTranscription`, `onTranscribeProgress`, `onTranscribeComplete`,
`selectGroup`, `ensureSelectionVisible`, `updateActiveGroup`.
`recomputeVisibleGroups()` is called from `rebuildEditedModel()` on every
cut/undo/reorder, and `transcriptState === 'ready'` gates the export chooser,
mic-mute and the analyzer — child-owned data would go stale behind the `*ngIf`.

**Hazards:** `scrollActiveGroupIntoView` is called **synchronously** from
`updateActiveGroup(true)` in the rAF `tick()` and from `setPlayhead` — keep the
imperative `this.transcriptPane?.scrollGroupIntoView(idx)` via
`@ViewChild(TranscriptPaneComponent)`; do NOT convert to Input/ngOnChanges
(defers the scroll, changes karaoke feel). `scrollGroupIntoView` indexes
`cont.children[idx]` — preserve element order (`.tx-empty-results` only appears
when the list is empty). `transcribeEtaLabel` getter never returns `''` (its
`*ngIf` is always true) — preserve verbatim, quirk included. Search input is
`[value]` + `(input)`, NOT ngModel — keep (cursor behavior). `isTypingTarget`
guard stays in the shell and keeps working (inspects `ev.target`).

Yield: ~66 HTML, ~340 SCSS, ~50 TS.

### Step 8 — `viewer-pane/` → `app-editor-viewer`

**Template moves:** HTML 550–564 (`.viewer-wrap` section incl. `#viewerVideo` +
transport bar) → `<app-editor-viewer *ngIf="manifest" …>`.
**SCSS moves:** 1134–1216 (`.viewer-wrap` own props → `:host`, `.viewer-box`,
`.viewer-video`, `.transport-bar`, `.timecode`, `.transport-error`).

**Contract:**
```ts
@Input() timecode = ''; @Input() isPlaying = false;
@Input() playbackRate = 1; @Input() transportError = '';
@Output() playToggled;
@ViewChild('viewerVideo') videoRef!: ElementRef<HTMLVideoElement>;
get videoEl(): HTMLVideoElement | undefined { return this.videoRef?.nativeElement; }
```

**Stays in shell:** the entire playback engine (`tick()` is a 60 Hz loop
writing `playheadTime`, syncing media, calling `updateActiveGroup(true)` and
`requestRender()` — three panes per frame; moving it into a leaf inverts
playhead ownership). Shell reaches the element via
`@ViewChild(EditorViewerComponent) viewer?;` replacing
`this.viewerVideoRef?.nativeElement` with `this.viewer?.videoEl` at five sites:
`resetSessionState` (773), `stopPlayback` (5666), `applyRateToElements` (5608),
`syncViewer` (5731), `seekViewerToPlayhead`.

**Hazards:** `resetSessionState()` runs before `ngAfterViewInit` on first load
and while `manifest` is null (child unrendered) — the double-optional chain must
be preserved at all five sites; declare the ViewChild optional (`?`), not `!`.
The viewer IS destroyed/recreated on session switch (`resetSessionState` nulls
`manifest`, `cdr.detectChanges()` at 716 runs) — identical as long as
`*ngIf="manifest"` sits on the child host in the same place. `v.onerror`
assigned in `syncViewer` per file change. `transportError` written from eight
places — stays shell state, Input into the viewer.

Yield: ~15 HTML, ~85 SCSS, ~0 TS. Take for SCSS isolation + Content Studio
portability.

### Step 9 — `services/story-analysis.service.ts` + `model/transcript-segments.ts`

**`model/transcript-segments.ts`** (pure — reads only `transcript.words`,
`transcriptTracks`, `EPS`, the `SEG_*` constants):
`SEG_MAX_WORDS = 20, SEG_MIN_WORDS = 4, SEG_GAP_SECONDS = 2`;
`segmentsForRegions` (4365–4409); `speakerForTrack` (4419–4427) — **keeps its
throw verbatim**; `transcriptTextForRegions` (4430–4432).

**`StoryAnalysisService`** — `@Injectable()`, **provided on `EditorComponent`'s
`providers: []`**, not root. Depends only on `ElectronService`. Moves:
`ollamaModels`, `ollamaConnected`, `selectedOllamaModel`, `OLLAMA_MODEL_KEY`
(475–481); `refreshOllamaModels` (4275–4290), `defaultOllamaModel` (4301–4309),
`onOllamaModelChange` (4342–4345); `analyzeStopRequested` (487), `stopAnalysis`
(4318–4329), `isStopError` (4332–4339); thin wrappers `analyzeChapters`,
`suggestTitle`, `unloadModel`.

**Stays in shell:** `analyzing`, `analyzeMessage`, `analyzeError`,
`aiProgress*`, `analyzeTimeline` (4446–4592), `ensureStoryChapters`
(3962–4015), `deriveStoryChapters` (4042–4086), the whole titles-handoff block.
These orchestrate the activity queue, mutate `stories`, call
`scheduleEditsSave`/`requestRender`, write `transportError` — shell concerns.
Shell exposes `selectedOllamaModel`/`ollamaModels`/`ollamaConnected` as
delegating getters (templates bind them).

**Hazards:** `isStopError` reads `analyzeStopRequested` — **both move together
or neither** (service becomes single owner of the stop flag).
`refreshOllamaModels` ends with `cdr.detectChanges()` — service has no cdr;
return `Promise<void>`, the two call sites (`ngOnInit` 660, the ⟳ button) do
`detectChanges()`. `onStoryAnalyzeProgress` registration stays in the shell.
localStorage key `editor.ollamaModel.v2` moves with the service, unrenamed.
`cancelSplit()` → `this.analysis.stopAnalysis()` via the split modal's Output
in step 10.

Yield: ~130 lines.

### Step 10 — `story-split-modal/` → `app-story-split-modal`

**Template moves:** HTML 237–316 → `<app-story-split-modal *ngIf="splitModalOpen" …>`.
**SCSS moves:** `@keyframes split-sweep` (1595–1600), `.split-modal`
(1610–end). Child `@use`s `styles/_modal.scss` — the split modal's footer uses
`.modal-btn`/`.modal-btn.primary` and its backdrop is `.modal-backdrop`;
forgetting the partial = unstyled dialog.

**TS moves:** `splitModalOpen`(→local `open`)/`splitRunning`/`splitError`/
`splitStory`/`splitStoryTitle`/`splitChapters`/`splitAssign`/`splitBuckets`/
`splitActiveBucket`/`splitAnalyzedRegions`/`splitFromCache` (503–518);
`openSplitModal` (4597–4622); `persistSplitCache` (4626–4637), `startSplit`
(4641–4644), `runSplitDetection` (4649–4695), `splitCoverage` (4699–4705),
`setSplitActiveBucket`, `addSplitBucket`, `removeSplitBucket`,
`onSplitBucketTitle`, `clickSplitChapter`, `splitBucketColor`,
`splitBucketCount`, `splitScrapCount`, `splitAnyAssigned` (4707–4745),
`confirmSplit` (4849–4910), `cancelSplit` (4914–4920), `closeSplitModal`
(4923–4935), `chapterClock` (4788–4791), **and `storyLocalTime`** (verified
used only by `chapterClock`) — child calls
`this.timeMap.editedRangesForOriginal`.

**Contract:**
```ts
@Input() story!: Story;                  // by reference
@Input() stories: Story[] = [];          // number/colour preview
@Input() timeMap!: EditedTimeMap;
@Input() transcript: Transcript | null = null;
@Input() transcriptTracks: { id: string; label: string }[] = [];
@Input() models: { id: string; name: string }[] = [];
@Input() model = '';
@Input() aiProgressDone = 0; @Input() aiProgressTotal = 0; @Input() aiPhase = '';
@Output() modelChange: EventEmitter<string>;
@Output() stopRequested;
@Output() applied: EventEmitter<{ /* bucket layout; shell mints ids */ }>;
@Output() changed;    // → scheduleEditsSave + requestRender
@Output() closed;
```
Child mutates `story.regions`/`story.title`/`story.split`/`story.chapters` in
place (as today) and emits `applied` with the bucket layout; the **shell** mints
ids (`storyIdCounter` is shell state), splices the new stories, and runs the
exact tail of `confirmSplit` (4900–4909): `renumberStories()`,
`storySelection = null`, `scheduleEditsSave()`, `requestRender()`.

**Hazards:** `runSplitDetection` writes `aiProgress*` — those are shared with
the dock and `analyzeTimeline` (one analysis at a time). Keep them shell-owned:
child emits `progressReset`, shell zeroes; `onStoryAnalyzeProgress` keeps
writing; values flow down as Inputs. `cancelSplit` → `(stopRequested)` when
running. `openSplitModal` restores `story.split` cache / sets `splitFromCache`;
`cancelSplit` re-persists — both mutate `story.split` in place, preserve.
Backdrop `(click)="cancelSplit()"` + card `stopPropagation()` survive.

Yield: ~80 HTML, ~265 SCSS, ~180 TS.

### Step 11 — `story-list/` → `app-story-list`

**Largest, riskiest component extraction. Do it last.**

**Template moves:** HTML 366–476 (`.stories-pane`). The story context menu +
backdrop (HTML 60–74) **stays in the shell** — `onCanvasContextMenu` opens it
from the timeline; SCSS `.story-ctx` (259–285) + `.menu-backdrop` (286–292)
stay too.

**SCSS moves:** `.stories-pane` block (294–531) in full. Own props
(`flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden;
padding: 8px 10px; background: #202023;`) on `:host`; as a flex item it's
already blockified — do not add `display:`.

**TS moves:** `onStoryRowMouseDown` (3372–3382), `suppressStoryClick` +
`consumeStoryClickSuppression` (3385–3390) — one-shot flag consumed by three
handlers, all three move together, never read outside (verified) —
`onStoryRowClick`, `onStorySwatchClick`, `onStoryNumClick`,
`onStoryTitleInput` (3444–3452), `blurStoryInput` (3706–3708), `dragStoryId`,
`dropBeforeId`, `onStoryDragStart/Over/PaneDragOver/Drop/DragEnd` (3527–3590),
`onStoryRowContextMenu` (3597–3600), `storyDuration` (4130–4145), public
delegates for `storyColor`, `isStoryEmpty`, `storyChapterState`,
`storyApproxChapters`, `canSendStoryToTitles`.

**Contract:**
```ts
@Input() stories: Story[] = [];
@Input() timeMap!: EditedTimeMap;
@Input() activeStoryId: string | null = null;
@Input() storySelection: { storyId: string; regionIndex: number | null } | null = null;
@Input() mergeIds = new Set<string>();
@Input() analyzing = false; @Input() transcriptReady = false;
@Input() models: { id: string; name: string }[] = [];
@Input() model = ''; @Input() ollamaConnected = false;
@Output() modelChange; @Output() refreshModels; @Output() analyzeRequested;
@Output() mergeRequested; @Output() sendAllRequested;
@Output() sendOneRequested: EventEmitter<Story>;
@Output() splitRequested: EventEmitter<Story>;
@Output() deleteRequested: EventEmitter<Story>;
@Output() activeToggled: EventEmitter<string>;       // toggleActiveStory
@Output() wholeStorySelected: EventEmitter<Story>;   // selectWholeStory
@Output() mergePickToggled: EventEmitter<string>;    // toggleStoryMerge
@Output() mergePickCleared;                          // clearStoryMergePick
@Output() contextMenuRequested: EventEmitter<{ storyId: string; x: number; y: number }>;
@Output() reordered: EventEmitter<Story[]>;          // new array from onStoryDrop
@Output() changed;                                   // title typed → save + render
```

**Stays in shell (why):** `stories` (the array + `storyIdCounter`),
`activeStoryId`, `storySelection`, `storyMergeIds`, `storyCtxMenu`, and every
mutation/selection/merge/paint/renumber method + the titles-handoff block — all
also driven from the **canvas** (ribbon click, ⌘-click, edge drag, paint,
right-click) or the **keyboard** (`S`, `Delete`, `Cmd+X`, `Escape`), which stay
in the shell.

**Hazards:** `onStoryTitleInput` mutates `story.title` in place + sets
`story.titleTouched = true` — keep in child (has the reference), emit `changed`;
shell runs `scheduleEditsSave(); requestRender();` in that order (titleTouched
protects user-typed names from auto-titling). `onStoryDrop` reassigns
`this.stories` (3576) — child emits the reordered array; shell assigns then
`renumberStories(); scheduleEditsSave(); requestRender(); cdr.detectChanges();`
(exact tail 3579–3582). `.story-title` input is `[value]` + `(input)`, keep, and
keep `id="story-title-{{ s.id }}"`. `(keydown.enter)="blurStoryInput($event)"`
needs it public. Story rows are `<ng-container *ngFor>` with `.story-drop-line`
sibling — position-sensitive, move verbatim.
`<app-story-list *ngIf="storyMode">` sits where `.stories-pane` sat.

Yield: ~110 HTML, ~240 SCSS, ~230 TS.

### Step 12 — `topbar/` → `app-editor-topbar` (optional)

HTML 20–58, SCSS `.topbar` 138–258. `.menu-backdrop` stays in the shell (story
ctx menu uses it) or moves to `_modal.scss` used by both.
Contract: `@Input() sessionName, menuOpen, cutCount, removedLabel, canExport,
exporting, muteMic, canMuteMic;` `@Output() menuToggled, exportRequested,
openRequested, addProjectRequested, muteMicToggled, menuDismissed`.
**`menuOpen` stays shell-owned** — set false from canvas mousedown (1965),
Escape, and `onExport`'s finally.
Yield: ~40 HTML, ~120 SCSS, ~15 TS. Low value; only if everything else is done.

---

## 3. Shared helpers — explicit homes (no duplication)

| Helper | Used by | Home |
|---|---|---|
| `requestRender` | 50 sites, every region | **Shell only.** Children emit; shell renders. |
| `prettyLabel` | gutter (shell), tx chips + labels (transcript child) | `model/editor-format.ts`; each component keeps a 1-line public delegate |
| `pad2` | ruler/timecode/removedLabel/fmtClock | `model/editor-format.ts` |
| `formatTimecode` | transport readout, `recomputeVisibleGroups` | `model/editor-format.ts`, `(t, frameSeconds)` |
| `formatRulerLabel` | `drawRuler` (renderer), `storyChapterTimestamps` (shell) | `model/editor-format.ts` |
| `fmtClock` | `chapterClock` only | `model/editor-format.ts` |
| `originalToEdited` / `editedToOriginal` / `editedRangesForOriginal` | shell + split modal + story list | **Shell**, via `EditedTimeMap`. `originalSpansForEdited` is shell-only, off the interface. |
| `mergeRanges` / `mergeRegions` / `mergeCuts` | many | `model/editor-math.ts` |
| `storyColor` / `storiesForDisplay` / `regionFingerprint` / `setStoryChapters` / `storyChapterState` | stories, ribbon, split, analysis | `model/story-utils.ts` |
| `segmentsForRegions` / `speakerForTrack` | analysis + split + titles | `model/transcript-segments.ts` |
| `isStopError` + `analyzeStopRequested` | analysis loop, split modal | `StoryAnalysisService` (move as a pair) |
| `roundRectPath` | 4 draw functions | `timeline/timeline-renderer.ts` (private) |
| `EPS` | ~60 sites | `model/editor-math.ts` module constant |
| FCP px constants | trackRows, hit-testing, gutter, renderer | `timeline/timeline-metrics.ts` |

---

## 4. What NOT to extract

**The timeline canvas, its interaction web, the splitters, and the scrollbar
stay in the shell.**

- `onWindowMouseMove`/`onWindowMouseUp` (2394–2474) is one dispatcher for nine
  drag modes, three of which are pane splitters that live in the shell's layout.
- `onCanvasMouseDown` (1962–2129) reads/writes `menuOpen`, `storySelection`,
  `storyMergeIds`, `draggingStoryEdge`, `stories[].regions`, `selectedRanges`,
  `selStart/selEnd`, `selectedGroupStart/End`, `moveDrag`, `marquee*`,
  `toolMode`, `bladeBoundaries`, `playheadTime`, `sequence` — every one read by
  another pane.
- `moveSelectionTo` (2256–2328) rewrites `sequence`, calls
  `rebuildEditedModel`, re-selects, `renumberStoriesByTimeline`, lands the
  playhead. It is the edit model, not a view.
- `setPlayhead` (2560–2572) fans out to media sync, transcript karaoke, render.

Instead, split it **internally** (steps 5–6): drawing (~653 lines) and the
waveform cache (~85) come out as plain classes. 74% of the timeline region's
line count, none of the interaction risk.

**Also stays:** bootstrap/session lifecycle (628–895) — `resetSessionState`
touches ~55 fields spanning every pane; edit model + time maps (896–1147);
edits persistence (2937–3032); keyboard (2664–2772) — the shell HostListener is
the only place that can arbitrate `S`/`Delete`/`Escape` routing; recents +
projects wiring (4970–5169; recents block is legacy, do not invest);
**the `.empty-workspace` block and `*ngIf="manifest"` gating** — every
extraction reproduces the gate on the child's host element in the same
position; check the no-session state after every step.

---

## 5. Recommended stopping point

Ranked by lines removed per unit of risk: 6 (renderer, ~660, medium/visual),
1 (types, ~205, near zero), 2 (pure modules, ~180, low), 11 (story list, ~580,
highest), 10 (split modal, ~525, medium-high), 7 (transcript pane, ~455,
low-medium), 3 (activity dock, ~290, low), 4 (export modals, ~240, low),
12 (topbar, ~175, low), 9 (analysis service, ~130, medium), 5 (waveform cache,
~85, low), 8 (viewer, ~100, low-medium).

**Stop after step 7.** Steps 1→7 remove ~1,970 lines from the TS
(5,783 → ~3,800) plus ~700 SCSS and ~215 HTML, and establish every pattern the
rest reuses. If time is very short: **steps 1, 2, 5, 6 only** — four commits,
~1,130 lines, no template or SCSS touched, no encapsulation risk possible.

---

## 6. Post-step checklist (every step, no exceptions)

```
cd frontend && npx tsc --noEmit -p tsconfig.app.json && npx ng build --configuration development
```

Then, manually, in the running app:

1. **No-session state** — Editor from side nav with no session: projects
   sidebar live, `.empty-workspace` card, "Add Project…" works.
2. **Load a session** — timeline draws, waveforms fill, gutter labels align.
3. **Fatal-error path** — `dismissError()` returns to the empty workspace; the
   same project can be re-opened.
4. **Session switch** — second project into the same window; nothing leaks
   (playback stopped, transcript reset, stories reset, dock closed).
5. **The pane just touched** — click every control once.

Checklist notes: `tsc -p tsconfig.app.json` only checks files reachable by
import — import new modules from the shell in the same commit. `tsc` does not
check templates; `ng build` does (`strictTemplates` +
`strictInputAccessModifiers`: a member demoted to private while a template reads
it fails there and only there). Every new component: `app.module.ts`
`declarations` + `standalone: false`. FormsModule only — the split-bucket
titles and search box are `[value]`/`(input)` and must stay that way.

Reference pattern for a `standalone: false` child with Inputs/Outputs and its
own `.scss`: `components/project-sidebar/project-sidebar.component.ts`.
