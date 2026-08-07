import { Component, EventEmitter, Input, OnDestroy, OnInit, Output, ChangeDetectorRef } from '@angular/core';
import { Subscription } from 'rxjs';
import { ElectronService } from '../../services/electron.service';
import { ProcessingService, ProcessingJob } from '../../services/processing.service';
import { ProjectEntry } from '../../services/projects.service';
import { buildWorkflowOptions } from '../../services/workflow-payload';
import {
  AudioSource, AudioSourceType, VideoSourceType, MediaSourceType,
  MEDIA_SOURCE_LABELS, VIDEO_CONTINUATION_PARTS
} from '../../models/types';

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

  rows: AudioSource[] = [];
  mediaSourceLabels = MEDIA_SOURCE_LABELS;
  private readonly audioTypes: AudioSourceType[] = ['mic1', 'mic2', 'mic3', 'mic4', 'screen', 'game', 'soundEffects', 'bluetooth', 'mic1Sb', 'mic2Sb', 'mic3Sb', 'mic4Sb', 'screenSb', 'desktopSb', 'gameSb', 'bluetoothSb', 'soundEffectsSb'];
  private readonly videoTypes: VideoSourceType[] = ['cam1', 'cam2', 'screenVideo', 'gameVideo',
                                                    'screenVideo2', 'screenVideo3',
                                                    'gameVideo2', 'gameVideo3'];
  private readonly allMediaTypes: MediaSourceType[] = [...this.audioTypes, ...this.videoTypes];

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
   * Ask the backend which companion files belong to this project's master video and turn the
   * answer into editable rows — the same shape (and the same syncFix/applyDrift defaults) the
   * workflow page's auto-detect produces.
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
    this.cdr.detectChanges();

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

    const rows: AudioSource[] = [];
    const stamp = Date.now();
    for (const [audioType, audioPath] of Object.entries(result.audioFiles || {})) {
      rows.push({
        id: `audio_${stamp}_${audioType}`,
        path: audioPath,
        name: this.basename(audioPath),
        type: audioType as AudioSourceType,
        syncFix: false,
        applyDrift: false,
        isVideo: false
      });
    }
    for (const [videoType, videoPath] of Object.entries(result.videoFiles || {})) {
      if (typeof videoPath !== 'string') continue;
      rows.push({
        id: `video_${stamp}_${videoType}`,
        path: videoPath,
        name: this.basename(videoPath),
        type: videoType as VideoSourceType,
        syncFix: false,
        applyDrift: false,
        isVideo: true
      });
    }
    this.rows = rows;
    this.state = 'ready';
    this.cdr.detectChanges();
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

  /** Audio first, then soundboard, then video in declared order (parts under their base). */
  get sortedRows(): AudioSource[] {
    return [...this.rows].sort((a, b) => {
      const category = (s: AudioSource): number => {
        if (s.isVideo) return 2;
        if (s.type && s.type.toString().endsWith('Sb')) return 1;
        return 0;
      };
      const ca = category(a);
      const cb = category(b);
      if (ca !== cb) return ca - cb;
      if (ca === 2) {
        return this.videoTypes.indexOf(a.type as VideoSourceType)
             - this.videoTypes.indexOf(b.type as VideoSourceType);
      }
      return 0;
    });
  }

  availableTypes(currentType: MediaSourceType | ''): MediaSourceType[] {
    const used = this.rows
      .filter(s => s.type && s.type !== currentType)
      .map(s => s.type as MediaSourceType);
    return this.allMediaTypes.filter(t => !used.includes(t));
  }

  isContinuationPart(row: AudioSource): boolean {
    return !!row.type && !!VIDEO_CONTINUATION_PARTS[row.type as string];
  }

  /**
   * Seam gap entry. Blank means "measure this seam against the master", which is what should
   * normally happen; a number is only needed when the part carries no audio to measure with.
   */
  setSeamGap(row: AudioSource, value: string): void {
    const trimmed = (value || '').trim();
    if (!trimmed) {
      row.seamGapSeconds = null;
      return;
    }
    const parsed = Number(trimmed);
    row.seamGapSeconds = Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  /**
   * Swap the file behind a row. The row's TYPE is what the pipeline dispatches on, so a file
   * of the wrong kind for that type is refused rather than quietly mapped to the wrong lane —
   * change the type first if that is what was meant.
   */
  async changeRowFile(row: AudioSource): Promise<void> {
    let picked: { canceled: boolean; filePaths: string[] };
    try {
      picked = await this.electron.selectFile({
        title: `Choose the file for ${row.type ? this.mediaSourceLabels[row.type] : 'this source'}`,
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
    const isVideo = /\.(mp4|mov|avi|mkv)$/i.test(path);
    if (isVideo !== !!row.isVideo) {
      this.error = row.isVideo
        ? `“${this.basename(path)}” is not a video file, and this is a video source.`
        : `“${this.basename(path)}” is a video file, and this is an audio source.`;
      this.cdr.detectChanges();
      return;
    }
    row.path = path;
    row.name = this.basename(path);
    this.error = null;
    this.cdr.detectChanges();
  }

  removeRow(row: AudioSource): void {
    this.rows = this.rows.filter(r => r.id !== row.id);
  }

  trackByRowId = (_: number, row: AudioSource) => row.id;

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
      const { options, errors } = buildWorkflowOptions({
        masterVideo: this.masterVideo,
        sources: this.rows,
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
}
