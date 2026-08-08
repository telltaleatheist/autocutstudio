import { Component, EventEmitter, Input, OnDestroy, OnInit, Output, ChangeDetectorRef } from '@angular/core';
import { Subscription } from 'rxjs';
import { ElectronService } from '../../../services/electron.service';
import { ProcessingService, ProcessingJob } from '../../../services/processing.service';
import { ProjectEntry } from '../services/projects.service';
import { buildWorkflowOptions } from '../../../services/workflow-payload';
import {
  AudioSource, AudioSourceType, VideoSourceType, MediaSourceType,
  MEDIA_SOURCE_LABELS, VIDEO_CONTINUATION_PARTS
} from '../../../models/types';

/**
 * Process a RAW project without leaving the editor: detect its companion files, confirm the
 * few options that change the run, start the pipeline, and watch it finish.
 *
 * It is the same payload the old workflow page sends — literally, through the shared builder —
 * minus manual alignment, which stays on that page (alignmentOverrides is always null here).
 *
 * Failures are inline and specific: a detection that fails says why and offers a retry, a
 * payload the builder rejects prints the builder's own reason, and a job that fails shows
 * Python's error text. Nothing here alerts, and nothing is silently skipped.
 *
 * Closing the modal does NOT cancel a running job — the run belongs to the app, not to this
 * window's DOM. Reopening re-attaches to it (see `attachRunning`).
 */
export type ProjectSetupState = 'idle' | 'detecting' | 'ready' | 'running' | 'done' | 'error';

/**
 * One line of the source list. The list is driven by the source types the pipeline can USE
 * (Camera 1, Mic 1, Screen Audio…), not by whatever files happen to be in the folder: the
 * left column is fixed and the file is chosen on the right. A slot with no file is simply
 * not part of the run.
 */
export interface SourceSlot {
  type: MediaSourceType;
  label: string;
  isVideo: boolean;
  /** The chosen file, or '' for "not used in this run". */
  path: string;
  /** Continuation parts only: seconds of nothing before this part starts (null = measure it). */
  seamGapSeconds: number | null;
}

/** A file that can be assigned to a slot. */
interface FileCandidate {
  path: string;
  name: string;
  isVideo: boolean;
}

const VIDEO_EXT = /\.(mp4|mov|avi|mkv|m4v|webm)$/i;
const AUDIO_EXT = /\.(wav|mp3|aac|flac|ogg|m4a)$/i;
/** This pipeline's own derived audio. Never an input — offering it invites a silent mistake. */
const DERIVED_SUFFIX = /_processed\.[a-z0-9]+$/i;

/**
 * The wav a screen/game CAPTURE writes beside its mp4 ("… screen capture 1.wav"). It carries
 * the capture's own audio, not the session's desktop feed, and a lost feed still records a
 * full-length SILENT track — so choosing one can replace the real screen audio with nothing.
 * `auto-detect-audio` refuses to assign them for exactly that reason; the dropdowns keep the
 * same rule rather than offering the mistake by hand.
 */
const CAPTURE_COMPANION = /\s(?:screen|game)\s*capture(\s*\d+)?\.(wav|mp3|aac|flac|ogg|m4a)$/i;

@Component({
  selector: 'app-project-setup-modal',
  templateUrl: './project-setup-modal.component.html',
  styleUrls: ['./project-setup-modal.component.scss'],
  standalone: false
})
export class ProjectSetupModalComponent implements OnInit, OnDestroy {
  /** The project being processed. The host renders this component only while it has one. */
  @Input() entry: ProjectEntry | null = null;
  /**
   * True when the host already has a job running FOR THIS ENTRY: skip detection and bind
   * straight onto the live job, so reopening mid-run shows the run instead of restarting setup.
   */
  @Input() attachRunning = false;

  /** The user dismissed the modal. The job (if any) keeps running. */
  @Output() closed = new EventEmitter<void>();
  /** A job was started here — the host records which entry owns it. */
  @Output() started = new EventEmitter<void>();
  /** The run finished and produced a session. The host rescans, stamps and opens it. */
  @Output() completed = new EventEmitter<{ zipPath: string }>();

  state: ProjectSetupState = 'idle';
  /** Inline failure text for the CURRENT state (detection, payload, start, or the job). */
  error: string | null = null;
  /**
   * Said out loud when detection matched nothing. A list of empty dropdowns is otherwise
   * indistinguishable from a detect that worked and found a folder with nothing in it.
   */
  detectNote: string | null = null;

  /** The source list, in display order. Left column = these; right column = their files. */
  slots: SourceSlot[] = [];
  /** Every file that can be assigned, gathered from the project folder. */
  candidates: FileCandidate[] = [];
  mediaSourceLabels = MEDIA_SOURCE_LABELS;

  private readonly videoTypes: VideoSourceType[] = ['cam1', 'cam2',
                                                    'screenVideo', 'screenVideo2', 'screenVideo3',
                                                    'gameVideo', 'gameVideo2', 'gameVideo3'];
  private readonly audioTypes: AudioSourceType[] = ['mic1', 'mic2', 'mic3', 'mic4', 'screen', 'game', 'soundEffects', 'bluetooth', 'mic1Sb', 'mic2Sb', 'mic3Sb', 'mic4Sb', 'screenSb', 'desktopSb', 'gameSb', 'bluetoothSb', 'soundEffectsSb'];
  /** Display order for the whole list — video first, then audio, then soundboard. */
  private readonly slotOrder: MediaSourceType[] = [...this.videoTypes, ...this.audioTypes];
  /**
   * Always listed, even when nothing was detected for them: the everyday set, so the list
   * reads as "here is what this project can have" rather than "here is what we found".
   * Anything else appears once it has a file, or via "Add source".
   */
  private readonly coreTypes: MediaSourceType[] =
    ['cam1', 'cam2', 'screenVideo', 'gameVideo', 'mic1', 'mic2', 'screen', 'game'];

  // Options — same defaults as the workflow page.
  autoDuck = true;
  useDownloadedStream = false;
  denoiseMics = false;
  /** The voice-separator asset gate; the Denoise toggle only exists once it is installed. */
  separatorInstalled = false;

  /** The live job, once this modal owns one. Drives every running/done/error readout. */
  job: ProcessingJob | null = null;
  /** Cancel asks first, in the modal — no window.confirm(). */
  confirmingCancel = false;
  /** Synchronous guard so a double-click cannot start two runs. */
  private starting = false;
  /** Set before startWorkflow so the job emitted during the await is recognised as ours. */
  private attached = false;
  private ownedJobId: string | null = null;
  private jobSub?: Subscription;

  constructor(
    private electron: ElectronService,
    private processing: ProcessingService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.attached = this.attachRunning;
    this.jobSub = this.processing.getCurrentJob().subscribe(job => this.onJob(job));
    void this.refreshSeparatorStatus();
    if (!this.attachRunning) {
      void this.detect();
    }
  }

  ngOnDestroy(): void {
    this.jobSub?.unsubscribe();
  }

  // ── Detection ───────────────────────────────────────────────────────────────

  /**
   * Build the source list: read every assignable file out of the project folder, then let the
   * backend's naming-convention detector say which file belongs to which source type. The
   * detector's answer is a starting point — every slot stays editable.
   */
  async detect(): Promise<void> {
    const master = this.entry?.scan?.masterVideo;
    if (!master) {
      this.state = 'error';
      this.error = `“${this.entry?.name || 'This project'}” has no master video on disk, so there is nothing to detect against.`;
      this.cdr.detectChanges();
      return;
    }

    this.state = 'detecting';
    this.error = null;
    this.detectNote = null;
    this.cdr.detectChanges();

    try {
      this.candidates = await this.listCandidates(master);
    } catch (err: any) {
      this.state = 'error';
      this.error = `Could not read the project folder: ${err?.message || String(err)}`;
      this.cdr.detectChanges();
      return;
    }

    let result: { success: boolean; audioFiles?: { [key: string]: string }; videoFiles?: { [key: string]: string }; error?: string };
    try {
      result = await this.electron.autoDetectAudio(master);
    } catch (err: any) {
      this.state = 'error';
      this.error = `Could not detect the companion files: ${err?.message || String(err)}`;
      this.cdr.detectChanges();
      return;
    }

    if (!result.success) {
      this.state = 'error';
      this.error = result.error || 'Detection failed and gave no reason.';
      this.cdr.detectChanges();
      return;
    }

    const assigned = new Map<MediaSourceType, string>();
    for (const [type, path] of Object.entries(result.audioFiles || {})) {
      if (typeof path === 'string' && path) assigned.set(type as MediaSourceType, path);
    }
    for (const [type, path] of Object.entries(result.videoFiles || {})) {
      if (typeof path === 'string' && path) assigned.set(type as MediaSourceType, path);
    }
    // The detector can name a file the folder listing did not (it resolves paths itself), and a
    // slot must never point at something its own dropdown cannot show.
    for (const path of assigned.values()) this.ensureCandidate(path);

    this.slots = this.buildSlots(assigned);
    // Nothing matched, but there ARE files to match against: the naming convention did not fit
    // this folder. Say so — every dropdown reading “None” is otherwise a silent failure.
    this.detectNote = (assigned.size === 0 && this.candidates.length > 0)
      ? `Nothing matched the naming convention for “${this.basename(master)}”. ` +
        `Pick the files by hand below.`
      : null;
    this.state = 'ready';
    this.cdr.detectChanges();
  }

  /**
   * Every media file in the project folder that could be a SOURCE: the master is excluded (it
   * is the thing everything aligns to) and so are this pipeline's own `_processed` outputs.
   *
   * The folder is taken from the MASTER's own path, because that is what `auto-detect-audio`
   * scans (`path.dirname(masterVideoPath)`). Deriving it from the registry entry instead can
   * yield a different string for the same directory — a symlinked or differently-resolved
   * project folder — and then every detected path would miss its dropdown entry.
   */
  private async listCandidates(master: string): Promise<FileCandidate[]> {
    const folder = this.dirname(master);
    if (!folder) throw new Error(`could not derive a folder from the master video path: ${master}`);

    const res = await this.electron.readDirectory(folder);
    if (!res?.success) {
      throw new Error((res as any)?.error || 'the folder could not be listed');
    }
    return (res.files || [])
      .map((f: any) => String(f?.path || ''))
      .filter(p => p && p !== master && !DERIVED_SUFFIX.test(p))
      .filter(p => VIDEO_EXT.test(p) || AUDIO_EXT.test(p))
      .map(p => this.toCandidate(p))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private toCandidate(path: string): FileCandidate {
    return { path, name: this.basename(path), isVideo: VIDEO_EXT.test(path) };
  }

  /** Make a path selectable even if it did not come from the folder listing. */
  private ensureCandidate(path: string): void {
    if (this.candidates.some(c => c.path === path)) return;
    this.candidates = [...this.candidates, this.toCandidate(path)]
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private buildSlots(assigned: Map<MediaSourceType, string>): SourceSlot[] {
    const types = new Set<MediaSourceType>(this.coreTypes);
    for (const type of assigned.keys()) types.add(type);
    return this.slotOrder
      .filter(type => types.has(type))
      .map(type => this.makeSlot(type, assigned.get(type) || ''));
  }

  private makeSlot(type: MediaSourceType, path: string): SourceSlot {
    return {
      type,
      label: this.mediaSourceLabels[type],
      isVideo: this.videoTypes.includes(type as VideoSourceType),
      path,
      seamGapSeconds: null
    };
  }

  /** Install state of the optional voice-isolation component (the Denoise toggle's gate). */
  private async refreshSeparatorStatus(): Promise<void> {
    try {
      const res = await this.electron.listAssets();
      const comp = (res.components || []).find((c: any) => c.id === 'voice-separator-env');
      this.separatorInstalled = !!comp && comp.state === 'installed';
    } catch (err) {
      // Not fatal: the toggle stays hidden and the run proceeds without isolation, which is
      // exactly what an uninstalled component means. Reported to the console, not swallowed.
      console.error('[project-setup] voice-isolation status unreadable:', err);
      this.separatorInstalled = false;
    } finally {
      this.cdr.detectChanges();
    }
  }

  // ── Rows ────────────────────────────────────────────────────────────────────

  get masterVideo(): string {
    return this.entry?.scan?.masterVideo || '';
  }

  /** How many slots are actually feeding the run. */
  get assignedCount(): number {
    return this.slots.filter(s => s.path).length;
  }

  /**
   * The files this slot may be given: the right kind, minus any file another slot has already
   * claimed — one file cannot feed two sources. A VIDEO slot takes video files only; an AUDIO
   * slot also accepts video, because the pipeline extracts the audio track from one.
   */
  slotOptions(slot: SourceSlot): FileCandidate[] {
    const taken = new Set(this.slots.filter(s => s !== slot && s.path).map(s => s.path));
    return this.candidates.filter(c => {
      if (taken.has(c.path)) return false;
      if (slot.isVideo) return c.isVideo;
      // Audio slot: video is fine (the track gets extracted), a capture companion is not.
      return !CAPTURE_COMPANION.test(c.name);
    });
  }

  onSlotFile(slot: SourceSlot, path: string): void {
    slot.path = path || '';
    if (!slot.path) slot.seamGapSeconds = null;
    this.error = null;
  }

  /** Assign a file from outside the project folder. */
  async browseForSlot(slot: SourceSlot): Promise<void> {
    let picked: { canceled: boolean; filePaths: string[] };
    try {
      picked = await this.electron.selectFile({
        title: `Choose the file for ${slot.label}`,
        filters: [
          { name: 'All Media Files', extensions: ['wav', 'mp3', 'aac', 'flac', 'ogg', 'm4a', 'mp4', 'mov', 'avi', 'mkv'] },
          { name: 'Audio Files', extensions: ['wav', 'mp3', 'aac', 'flac', 'ogg', 'm4a'] },
          { name: 'Video Files', extensions: ['mp4', 'mov', 'avi', 'mkv'] }
        ]
      });
    } catch (err: any) {
      this.error = `Could not open the file picker: ${err?.message || String(err)}`;
      this.cdr.detectChanges();
      return;
    }
    if (picked.canceled || picked.filePaths.length === 0) return;

    const path = picked.filePaths[0];
    // A video source cannot be fed an audio file — there would be no picture to place.
    if (slot.isVideo && !VIDEO_EXT.test(path)) {
      this.error = `“${this.basename(path)}” is not a video file, and ${slot.label} is a video source.`;
      this.cdr.detectChanges();
      return;
    }
    this.ensureCandidate(path);
    slot.path = path;
    this.error = null;
    this.cdr.detectChanges();
  }

  /** Source types not on screen yet — the "Add source" picker. */
  get addableTypes(): MediaSourceType[] {
    const shown = new Set(this.slots.map(s => s.type));
    return this.slotOrder.filter(t => !shown.has(t));
  }

  addSlot(type: string): void {
    if (!type) return;
    const media = type as MediaSourceType;
    if (this.slots.some(s => s.type === media)) return;
    const next = [...this.slots, this.makeSlot(media, '')];
    this.slots = next.sort((a, b) =>
      this.slotOrder.indexOf(a.type) - this.slotOrder.indexOf(b.type));
    this.error = null;
  }

  /** Core slots are permanent (they read as the project's shape); the rest can be taken away. */
  isRemovable(slot: SourceSlot): boolean {
    return !this.coreTypes.includes(slot.type);
  }

  removeSlot(slot: SourceSlot): void {
    this.slots = this.slots.filter(s => s !== slot);
  }

  isContinuationPart(slot: SourceSlot): boolean {
    return !!VIDEO_CONTINUATION_PARTS[slot.type as string];
  }

  /**
   * Seam gap entry. Blank means "measure this seam against the master", which is what should
   * normally happen; a number is only needed when the part carries no audio to measure with.
   */
  setSeamGap(slot: SourceSlot, value: string): void {
    const trimmed = (value || '').trim();
    if (!trimmed) {
      slot.seamGapSeconds = null;
      return;
    }
    const parsed = Number(trimmed);
    slot.seamGapSeconds = Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  trackBySlotType = (_: number, slot: SourceSlot) => slot.type;

  /**
   * Slots → the payload builder's rows. Only assigned slots travel.
   *
   * `syncFix`/`applyDrift` are sent false, exactly as this modal's rows always were: the
   * workflow measures every source's offset and drift itself (GCC-PHAT), and these two flags
   * are read ONLY by the degraded framerate-only fallback that runs when that sync stack is
   * unavailable. There was never a correct value for a user to pick here, which is why the
   * checkboxes are gone rather than merely hidden.
   */
  private buildRows(): AudioSource[] {
    const stamp = Date.now();
    return this.slots.filter(s => s.path).map(s => ({
      id: `${s.isVideo ? 'video' : 'audio'}_${stamp}_${s.type}`,
      path: s.path,
      name: this.basename(s.path),
      type: s.type,
      syncFix: false,
      applyDrift: false,
      isVideo: s.isVideo,
      seamGapSeconds: s.seamGapSeconds
    }));
  }

  // ── Processing ──────────────────────────────────────────────────────────────

  /** A job started somewhere else is running: this modal must not overwrite it. */
  get otherJobRunning(): boolean {
    return !this.attached && !!this.job && this.job.status === 'running';
  }

  get canProcess(): boolean {
    return this.state === 'ready' && !this.starting && !this.otherJobRunning;
  }

  /** Why the Process button is disabled, so the block is never mysterious. */
  get processBlockedReason(): string | null {
    if (this.otherJobRunning) {
      return 'Another job is already running — only one can run at a time. Wait for it to finish.';
    }
    if (this.state === 'detecting') return 'Detecting the companion files…';
    if (this.state === 'error') return 'Fix the problem above first.';
    return null;
  }

  async onProcess(): Promise<void> {
    if (!this.canProcess) return;
    this.starting = true;
    this.error = null;
    try {
      // The dropdowns already hide a file another slot claims; Browse… can still land on one.
      // Two sources fed the same file would be aligned and mixed twice — refuse, don't guess.
      const chosen = this.slots.filter(s => s.path);
      const duplicate = chosen.find((s, i) => chosen.findIndex(o => o.path === s.path) !== i);
      if (duplicate) {
        const others = chosen.filter(s => s.path === duplicate.path).map(s => s.label).join(' and ');
        this.error = `“${this.basename(duplicate.path)}” is assigned to ${others}. ` +
                     `Each file can only feed one source.`;
        return;
      }

      const { options, errors } = buildWorkflowOptions({
        masterVideo: this.masterVideo,
        sources: this.buildRows(),
        autoDuck: this.autoDuck,
        denoiseMics: this.denoiseMics,
        separatorInstalled: this.separatorInstalled,
        useDownloadedStream: this.useDownloadedStream,
        // Manual alignment lives on the workflow page; runs started here are full auto.
        alignmentOverrides: null
      });
      if (!options) {
        this.error = errors.join('\n');
        return;
      }

      // Claim the job BEFORE starting: startWorkflow publishes the running job while we are
      // still awaiting it, and that first emission has to be recognised as ours.
      this.attached = true;
      this.ownedJobId = null;
      try {
        await this.processing.startWorkflow(options);
      } catch (err: any) {
        this.attached = false;
        this.error = `Could not start processing: ${err?.message || String(err)}`;
        return;
      }
      this.state = 'running';
      this.started.emit();
    } finally {
      this.starting = false;
      this.cdr.detectChanges();
    }
  }

  /**
   * Live job → modal state. Only the job this modal owns is watched: an unrelated job (or one
   * that replaced ours) cannot repaint this run's progress.
   */
  private onJob(job: ProcessingJob | null): void {
    if (!this.attached) {
      // Still tracked, purely so the Process button can refuse while it is running.
      this.job = job;
      this.cdr.detectChanges();
      return;
    }
    if (!job) return;
    if (this.ownedJobId && job.id !== this.ownedJobId) return;
    this.ownedJobId = job.id;
    this.job = job;

    if (job.status === 'running' || job.status === 'pending') {
      // Only the transition INTO the run clears the inline error; a later progress event must
      // not wipe out something the user needs to read (a skip that failed, say).
      if (this.state !== 'running') this.error = null;
      this.state = 'running';
    } else if (job.status === 'completed') {
      if (this.state === 'done') return;   // already handed off; emit exactly once
      const zipPath = job.results?.zipPath;
      if (typeof zipPath === 'string' && zipPath) {
        this.state = 'done';
        this.error = null;
        this.completed.emit({ zipPath });
      } else {
        // Exit code 0 but no session to open — a contradiction, said plainly.
        this.state = 'error';
        this.error = 'Processing reported success but produced no session zip.';
      }
    } else if (job.status === 'error') {
      this.state = 'error';
      this.error = job.error || job.message || this.tailOutput(job);
    }
    this.cdr.detectChanges();
  }

  /** Last few console lines, for a failure that carried no error text of its own. */
  private tailOutput(job: ProcessingJob): string {
    const tail = job.output.slice(-5).join('').split('\n').filter(l => l.trim());
    return tail.length ? tail.join('\n') : 'Processing failed and gave no reason.';
  }

  /** The run readout replaces the setup form once this modal owns a job. */
  get isRunView(): boolean {
    return this.attached && (this.state === 'running' || this.state === 'done' || this.state === 'error');
  }

  get consoleLines(): string[] {
    return this.job?.output || [];
  }

  get progress(): number {
    return this.job?.progress || 0;
  }

  get subProgress(): number {
    return this.job?.subProgress || 0;
  }

  get currentOperation(): string {
    return this.job?.currentOperation || '';
  }

  get canSkip(): boolean {
    return this.state === 'running' && !!this.job?.canSkipCurrent;
  }

  async onSkip(): Promise<void> {
    if (!this.canSkip) return;
    try {
      await this.electron.sendSkipSignal();
    } catch (err: any) {
      this.error = `Could not skip this operation: ${err?.message || String(err)}`;
      this.cdr.detectChanges();
    }
  }

  async onConfirmCancel(): Promise<void> {
    this.confirmingCancel = false;
    await this.processing.cancelJob();
  }

  // ── Chrome ──────────────────────────────────────────────────────────────────

  /** Dismiss. A running job is deliberately left running. */
  onClose(): void {
    this.closed.emit();
  }

  onBackdropClick(): void {
    if (this.confirmingCancel) return; // answer the cancel question first
    this.onClose();
  }

  private basename(p: string): string {
    return p.split(/[\\/]/).pop() || p;
  }

  /** The containing directory, with no trailing separator — matches Node's path.dirname. */
  private dirname(p: string): string {
    const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return idx > 0 ? p.slice(0, idx) : '';
  }
}
