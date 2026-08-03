import { Component, OnDestroy, OnInit, effect, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import {
  ElectronService,
  TitleFormat,
  TitleHandoff,
  TitleTarget,
} from '../../services/electron.service';
import { InputItem, InputsStateService } from '../../services/inputs-state';
import { JobQueueService, QueuedJob } from '../../services/job-queue';

/**
 * Metadata tab — build a list of things to describe, queue them, run them through the AI.
 *
 * This is ContentStudio's Inputs & Queue page ported over. Three ways in: type a subject,
 * drop/browse a video file, or take the chapter list the timeline editor hands over. Check
 * what you want, add it to the queue, press Start; the reports land in the Reports tab.
 *
 * The old Titles tab is not a panel here — a story handed over from the editor lands as an
 * ordinary item, and running it through the queue calls the local headline model and streams
 * the candidate titles into its own job row. Titles are the whole output of such a job: no
 * tags, no description, no report file.
 *
 * The IPC contract is ContentStudio's, verbatim — channel names and payload shapes both —
 * because the main-process half is the same code ported alongside this. See
 * electron/preload.ts for the one channel that had to be renamed and why.
 *
 * Doctrine: no silent fallbacks. A missing output directory, an unwritable one, a backend
 * warning about a chapter list that could not be built — all of it surfaces in the notice
 * strip verbatim. Nothing is swallowed to keep the page looking calm.
 */

/** Trained character bands. Mirrors TITLE_LENGTH_RANGE in the main process (display only). */
const LENGTH_RANGE: Record<TitleFormat, { min: number; max: number }> = {
  normal: { min: 45, max: 70 },
  livestream: { min: 45, max: 90 },
};

/** How many completions a titling job requests. Fixed at ten — the unit of work the model sets. */
const TITLE_COUNT = 10;

/** The trained target a titling job asks for. Not user-selectable: the queue runs the model at
 *  its best, and a knob for "aim lower" has no use here. */
const TITLE_TARGET: TitleTarget = 'top-decile';

interface PromptSetOption {
  id: string;
  name: string;
  platform: string;
  instructions_prompt?: string;
}

/** One line in the notice strip. Replaces ContentStudio's toast service — this app has none. */
interface Notice {
  id: number;
  kind: 'error' | 'warning' | 'success';
  title: string;
  text: string;
}

/** The one modal this page uses, in its four flavours. */
type ModalKind = 'text-add' | 'text-edit' | 'notes' | 'prompt';

@Component({
  selector: 'app-metadata',
  standalone: false,
  templateUrl: './metadata.component.html',
  styleUrl: './metadata.component.scss',
})
export class MetadataComponent implements OnInit, OnDestroy {
  // ── Notices ────────────────────────────────────────────────────────────────
  notices = signal<Notice[]>([]);
  private noticeSeq = 0;

  // ── Queue ──────────────────────────────────────────────────────────────────
  queueStarted = signal(false);
  expandedJobIds = signal<Set<string>>(new Set());

  /**
   * Universal "Transcribe only" toggle. When ON, Start Queue transcribes each pending job
   * and STOPS with the prompt held for review ('held'); pressing Start Queue again — with
   * only held jobs left — sends them. When OFF, one press transcribes AND sends.
   */
  transcribeOnly = signal(false);
  /** Locked at each Start Queue press so a transcribe run never auto-sends the 'held' jobs
   *  it just produced: a run processes only jobs of this status. */
  private queueRunTarget: 'pending' | 'held' = 'pending';

  private processingInterval: any = null;

  availablePromptSets = signal<PromptSetOption[]>([]);
  /** Set when the selected prompt set is not installed. Blocks generation rather than substituting
   *  another set — a run in the wrong editorial voice looks like a success and is not recoverable. */
  promptSetError = signal<string | null>(null);

  isDraggingOver = signal(false);

  // ── Modal ──────────────────────────────────────────────────────────────────
  modalKind = signal<ModalKind | null>(null);
  modalIndex = -1;
  modalTitle = '';
  modalText = '';
  modalReadOnly = false;

  // ── Titling jobs ───────────────────────────────────────────────────────────
  /** Exposed so the row can say how many titles a run writes without hardcoding the number. */
  readonly titleCount = TITLE_COUNT;
  /** "<jobId>:<index>" of the candidate most recently copied, for the brief "Copied" flash. */
  copiedKey: string | null = null;

  private copyTimer: ReturnType<typeof setTimeout> | null = null;
  private handoffSub: Subscription | null = null;
  /** Whether this tab has ever asked Ollama to load the title model — gates eviction on leave. */
  private hasRunTitles = false;
  /** Set to true the moment a queue run touches the title model, so the run can hand the ~9 GB
   *  back the instant it finishes rather than waiting for the user to leave the tab. */
  private runUsedTitleModel = false;
  /** The titling job currently in flight, so Cancel knows to abort the Ollama stream. */
  private titleJobId: string | null = null;
  /** Set by Cancel, so the abort that follows is read as a stop and not reported as a failure. */
  private stopRequested = false;

  constructor(
    private electron: ElectronService,
    public inputsState: InputsStateService,
    public jobQueue: JobQueueService
  ) {
    // A lone job is always worth expanding — there is nothing else competing for the space.
    effect(() => {
      const jobs = this.jobQueue.jobs();
      if (jobs.length === 1) {
        const expanded = this.expandedJobIds();
        if (!expanded.has(jobs[0].id)) {
          this.expandedJobIds.set(new Set(expanded).add(jobs[0].id));
        }
      }
    });
  }

  async ngOnInit(): Promise<void> {
    if (!this.electron.isElectron()) {
      this.notify('error', 'Desktop app required', 'Metadata generation runs local transcription and a local model — it needs the desktop app.');
      return;
    }

    // A handoff that landed before this tab existed, plus any that arrives while it is open.
    // A live delivery is drained as well as applied, so revisiting the tab does not replay it.
    this.handoffSub = this.electron.getTitleSubjectsHandoff().subscribe((hs) => {
      this.applyHandoffs(hs);
      this.electron.takePendingTitleSubjects().catch(() => {});
    });
    try {
      const pending = await this.electron.takePendingTitleSubjects();
      if (pending.length) this.applyHandoffs(pending);
    } catch (err: any) {
      this.notify('error', 'Stories', `Failed to collect the stories sent from the editor: ${err?.message || err}`);
    }

    await this.loadPromptSets();

    // Settings are read once per app run: the master prompt set is a preference, and
    // re-reading it on every visit would stomp a choice made two visits ago.
    if (!this.inputsState.hasLoadedSettings()) {
      try {
        const settings = await this.electron.getMetadataSettings();
        if (settings?.promptSet) this.inputsState.masterPromptSet.set(settings.promptSet);
        this.inputsState.markSettingsLoaded();
      } catch (err: any) {
        this.notify('error', 'Settings', `Failed to load settings: ${err?.message || err}`);
      }
    }
  }

  ngOnDestroy(): void {
    this.handoffSub?.unsubscribe();
    if (this.copyTimer !== null) clearTimeout(this.copyTimer);
    if (this.processingInterval) clearInterval(this.processingInterval);
    if (!this.electron.isElectron()) return;
    this.electron.removeTitlesProgressListener();
    // Leaving the tab: stop anything in flight and give the machine its ~9 GB back. Both are
    // best-effort — a failure here must not surface on a component that is already gone. Only
    // evict when this tab actually loaded the model; a visit that generated nothing has no
    // business unloading a model something else may be using.
    if (this.titleJobId) this.electron.cancelTitles().catch(() => {});
    if (this.hasRunTitles) this.electron.unloadTitleModel().catch(() => {});
  }

  // ── Notices ────────────────────────────────────────────────────────────────

  private notify(kind: Notice['kind'], title: string, text: string): void {
    const notice: Notice = { id: ++this.noticeSeq, kind, title, text };
    this.notices.update((n) => [...n, notice]);
    // Successes are acknowledgements and expire on their own. Errors and warnings stay
    // until dismissed — an error the user blinked past is an error they never saw.
    if (kind === 'success') {
      setTimeout(() => this.dismissNotice(notice.id), 6000);
    }
  }

  dismissNotice(id: number): void {
    this.notices.update((n) => n.filter((x) => x.id !== id));
  }

  // ── Prompt sets ────────────────────────────────────────────────────────────

  async loadPromptSets(): Promise<void> {
    try {
      const result = await this.electron.listPromptSets();
      if (!result?.success) return;
      const sets = result.promptSets || [];
      this.availablePromptSets.set(sets);

      // Check the selection against what is actually installed, and REFUSE if it is missing —
      // never quietly substitute another set. Prompt sets are the editorial voice; silently
      // generating a run against a different one produces plausible output in the wrong voice,
      // which is worse than no output because nothing downstream reveals the swap. Say what is
      // wrong, name what IS installed, and let the user choose.
      const current = this.inputsState.masterPromptSet();
      if (sets.length && !sets.some((ps) => ps.id === current)) {
        this.promptSetError.set(
          `Prompt set “${current}” is not installed. Pick one of: ` +
          sets.map((ps) => ps.id).join(', ')
        );
        this.notify('error', 'Prompt sets', this.promptSetError()!);
      } else {
        this.promptSetError.set(null);
      }
    } catch (err: any) {
      this.notify('error', 'Prompt sets', `Failed to load prompt sets: ${err?.message || err}`);
    }
  }

  getPromptSetName(promptSetId: string): string {
    return this.availablePromptSets().find((ps) => ps.id === promptSetId)?.name || promptSetId;
  }

  getPromptSetIcon(promptSetId: string): string {
    const ps = this.availablePromptSets().find((p) => p.id === promptSetId);
    return ps?.platform === 'youtube' ? '📺' : '🎙️';
  }

  isYouTubePromptSet(promptSetId: string): boolean {
    return this.availablePromptSets().find((ps) => ps.id === promptSetId)?.platform === 'youtube';
  }

  // ── Item list ──────────────────────────────────────────────────────────────

  get selectedItems(): InputItem[] {
    return this.inputsState.inputItems().filter((item) => item.selected);
  }

  get hasSelectedItems(): boolean {
    return this.selectedItems.length > 0;
  }

  get allItemsSelected(): boolean {
    const items = this.inputsState.inputItems();
    return items.length > 0 && items.every((item) => item.selected);
  }

  toggleSelectAll(): void {
    const allSelected = this.allItemsSelected;
    this.inputsState.inputItems().forEach((_, index) => this.toggleItemSelection(index, !allSelected));
  }

  toggleItemSelection(index: number, value?: boolean): void {
    const items = this.inputsState.inputItems();
    if (!items[index]) return;
    const newSelected = value !== undefined ? value : !items[index].selected;
    const updated = [...items];
    updated[index] = { ...updated[index], selected: newSelected };
    this.inputsState.inputItems.set(updated);
  }

  /** Master prompt set change rewrites EVERY item, compilation mode or not — the per-item
   *  dropdowns are merely disabled in compilation mode, not ignored. */
  onMasterPromptSetChange(promptSetId: string): void {
    this.inputsState.masterPromptSet.set(promptSetId);
    this.inputsState.inputItems.update((items) => items.map((item) => ({ ...item, promptSet: promptSetId })));
  }

  onCompilationModeChange(isCompilation: boolean): void {
    this.inputsState.compilationMode.set(isCompilation);
    if (isCompilation) {
      const master = this.inputsState.masterPromptSet();
      this.inputsState.inputItems.update((items) => items.map((item) => ({ ...item, promptSet: master })));
    }
  }

  updateItemPromptSet(index: number, promptSetId: string): void {
    const items = this.inputsState.inputItems();
    if (!items[index]) return;
    const updated = [...items];
    updated[index] = { ...updated[index], promptSet: promptSetId };
    this.inputsState.inputItems.set(updated);
  }

  removeInput(index: number): void {
    this.inputsState.removeItem(index);
  }

  clearAllInputs(): void {
    this.inputsState.clearItems();
  }

  /** Reorder is buttons, not drag: this app has no CDK drag-drop and pulling one in for a
   *  list that is rarely longer than a handful of rows is not worth the dependency. */
  moveItem(index: number, delta: number): void {
    const target = index + delta;
    if (target < 0 || target >= this.inputsState.inputItems().length) return;
    this.inputsState.reorderItems(index, target);
  }

  toggleChapterGeneration(index: number, value: boolean): void {
    const items = this.inputsState.inputItems();
    if (!items[index]) return;
    const updated = [...items];
    updated[index] = { ...updated[index], generateChapters: value };
    this.inputsState.inputItems.set(updated);
  }

  isTextSubject(item: InputItem): boolean {
    return item.type === 'text-subject' || item.type === 'subject';
  }

  /** Chapters need timestamped segments, which videos and imported transcripts both carry. */
  canGenerateChapters(item: InputItem): boolean {
    return item.type === 'video' || item.type === 'transcript' || item.type === 'transcript-import';
  }

  hasVideoItems(): boolean {
    return this.inputsState.inputItems().some((item) => this.canGenerateChapters(item));
  }

  allChaptersEnabled(): boolean {
    const videoItems = this.inputsState.inputItems().filter((item) => this.canGenerateChapters(item));
    return videoItems.length > 0 && videoItems.every((item) => item.generateChapters !== false);
  }

  someChaptersEnabled(): boolean {
    const videoItems = this.inputsState.inputItems().filter((item) => this.canGenerateChapters(item));
    return videoItems.length > 0 && videoItems.some((item) => item.generateChapters !== false);
  }

  toggleAllChapters(enabled: boolean): void {
    this.inputsState.inputItems.update((items) =>
      items.map((item) => (this.canGenerateChapters(item) ? { ...item, generateChapters: enabled } : item))
    );
  }

  // ── Adding items ───────────────────────────────────────────────────────────

  openTextSubjectModal(): void {
    this.modalKind.set('text-add');
    this.modalTitle = 'Add text subjects';
    this.modalText = '';
    this.modalReadOnly = false;
    this.modalIndex = -1;
  }

  openEditTextSubjectModal(index: number): void {
    const item = this.inputsState.inputItems()[index];
    if (!item) return;
    this.modalKind.set('text-edit');
    this.modalTitle = 'Edit text subject';
    this.modalText = item.textContent || item.path || '';
    this.modalReadOnly = false;
    this.modalIndex = index;
  }

  openNotesModal(index: number): void {
    const item = this.inputsState.inputItems()[index];
    if (!item) return;
    this.modalKind.set('notes');
    this.modalTitle = `Instructions for “${item.displayName}”`;
    this.modalText = item.notes || '';
    this.modalReadOnly = false;
    this.modalIndex = index;
  }

  /** View-only "Show prompt" for a transcribed ('held') job. Sending is Start Queue's job. */
  viewPrompt(job: QueuedJob): void {
    if (!job.heldPrompt) return;
    this.modalKind.set('prompt');
    this.modalTitle = `Prompt for “${job.name}”`;
    this.modalText = job.heldPrompt;
    this.modalReadOnly = true;
    this.modalIndex = -1;
  }

  closeModal(): void {
    this.modalKind.set(null);
    this.modalText = '';
    this.modalIndex = -1;
  }

  saveModal(): void {
    const kind = this.modalKind();
    if (kind === 'text-add') {
      // One item per non-blank line — pasting a chapter list gives one subject per chapter.
      const lines = this.modalText.split('\n').filter((line) => line.trim());
      lines.forEach((line) => this.addTextSubject(line.trim()));
    } else if (kind === 'text-edit') {
      const items = this.inputsState.inputItems();
      const item = items[this.modalIndex];
      if (item) {
        const content = this.modalText;
        const updated = [...items];
        updated[this.modalIndex] = {
          ...item,
          displayName: this.shortLabel(content.split('\n')[0].trim()) || 'Text subject',
          textContent: content,
          // path doubles as the dedup key for text subjects, so it tracks the content.
          path: content,
        };
        this.inputsState.inputItems.set(updated);
      }
    } else if (kind === 'notes') {
      const items = this.inputsState.inputItems();
      const item = items[this.modalIndex];
      if (item) {
        const updated = [...items];
        updated[this.modalIndex] = { ...item, notes: this.modalText.trim() || undefined };
        this.inputsState.inputItems.set(updated);
      }
    }
    this.closeModal();
  }

  private shortLabel(text: string): string {
    return text.length > 50 ? `${text.substring(0, 50)}…` : text;
  }

  private addTextSubject(content: string): void {
    if (!content) return;
    this.inputsState.addItem({
      type: 'subject',
      path: content,
      displayName: this.shortLabel(content),
      icon: '✍️',
      selected: true,
      promptSet: this.inputsState.masterPromptSet(),
      textContent: content,
    });
  }

  async browseFiles(): Promise<void> {
    try {
      const result = await this.electron.selectFiles();
      if (!result?.success || !result.files?.length) return;
      for (const filePath of result.files) await this.addPath(filePath);
    } catch (err: any) {
      this.notify('error', 'Browse files', err?.message || String(err));
    }
  }

  /** Classify a path and add it. Shared by the picker and the drop zone so both agree on
   *  what counts as a video, and on which types can produce chapters. */
  private async addPath(filePath: string, fallbackName?: string): Promise<void> {
    const fileName = fallbackName || filePath.split(/[/\\]/).pop() || filePath;

    let isDir = false;
    try {
      isDir = await this.electron.isDirectory(filePath);
    } catch (err: any) {
      this.notify('error', 'Add file', `Could not inspect ${fileName}: ${err?.message || err}`);
      return;
    }

    if (isDir) {
      this.inputsState.addItem({
        type: 'directory',
        path: filePath,
        displayName: fileName,
        icon: '📁',
        selected: true,
        promptSet: this.inputsState.masterPromptSet(),
      });
      return;
    }

    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    let icon = '📄';
    let type = 'file';

    if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v'].includes(ext)) {
      icon = '🎬';
      type = 'video';
    } else if (['mp3', 'wav', 'aiff', 'aif', 'm4a', 'aac', 'flac', 'ogg', 'wma'].includes(ext)) {
      icon = '🎵';
      type = 'video';
    } else if (ext === 'txt') {
      icon = '📝';
      type = 'transcript';
    } else if (ext === 'json') {
      // An AutoCutStudio transcript sidecar — already transcribed, so the run skips Whisper.
      icon = '🗣️';
      type = 'transcript-import';
    }

    this.inputsState.addItem({
      type,
      path: filePath,
      displayName: fileName,
      icon,
      selected: true,
      promptSet: this.inputsState.masterPromptSet(),
      generateChapters: type === 'video' || type === 'transcript-import' ? true : undefined,
    });
  }

  // ── Drop zone ──────────────────────────────────────────────────────────────

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingOver.set(true);
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingOver.set(false);
  }

  async onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingOver.set(false);

    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length === 0) return;

    for (const file of files) {
      // Electron 32 removed File.path, so the path comes back through the preload's
      // webUtils. An empty string means this was never a file on disk — say so instead of
      // adding a row that points nowhere and fails hours later inside a queue run.
      const filePath = this.electron.getPathForFile(file);
      if (!filePath) {
        this.notify('error', 'Drop', `Could not resolve a path for “${file.name}” — it was not dropped from the filesystem.`);
        continue;
      }
      await this.addPath(filePath, file.name);
    }
  }

  // ── Queue ──────────────────────────────────────────────────────────────────

  addToQueue(): void {
    const items = this.selectedItems;
    if (items.length === 0) return;

    if (this.inputsState.compilationMode()) {
      // Compilation: every checked item feeds ONE job, one report.
      const jobName =
        items.length === 1
          ? `${items[0].displayName} (compilation)`
          : `${this.shortLabel(items[0].displayName)} + ${items.length - 1} more (compilation)`;
      this.jobQueue.addJob(jobName, items, this.inputsState.masterPromptSet(), 'compilation');
    } else {
      // Individual: one job (and one report) per item.
      items.forEach((item) => this.jobQueue.addJob(item.displayName, [item], item.promptSet, 'individual'));
    }

    this.inputsState.inputItems().forEach((_, index) => this.toggleItemSelection(index, false));
  }

  async startQueue(): Promise<void> {
    if (this.queueStarted()) return;

    // Claim the guard immediately so a rapid double-click can't launch two queue processor
    // loops during the awaits below. Reset on every early-return path so the user can retry.
    this.queueStarted.set(true);

    // Lock this run's target: while any pending jobs exist we transcribe them (Stage 1 when
    // "Transcribe only" is on, a full run when off). Only once there are no pending jobs
    // does a Start Queue press send the held ones (Stage 2). Locked BEFORE the output-directory
    // check because that check only concerns the jobs this run will actually process.
    this.queueRunTarget = this.jobQueue.getPendingJobs().length > 0 ? 'pending' : 'held';
    const runJobs = this.queueRunTarget === 'held' ? this.jobQueue.getHeldJobs() : this.jobQueue.getPendingJobs();

    // Titling jobs write nothing to disk — their whole output is the candidate list in the row.
    // A run made only of them must not be blocked on a setting it will never read. One ordinary
    // job in the run and the check applies as before.
    if (runJobs.some((job) => !this.isTitleJob(job))) {
      try {
        const settings = await this.electron.getMetadataSettings();
        const outputDir = settings?.outputDirectory;

        if (!outputDir) {
          this.notify('error', 'Configuration', 'No output directory configured. Set one in Settings before processing.');
          this.queueStarted.set(false);
          return;
        }

        const dirCheck = await this.electron.checkDirectory(outputDir);
        if (!dirCheck.exists) {
          this.notify('error', 'Output directory', `Output directory does not exist: ${outputDir}`);
          this.queueStarted.set(false);
          return;
        }
        if (!dirCheck.writable) {
          this.notify('error', 'Output directory', `Output directory is not writable: ${outputDir}`);
          this.queueStarted.set(false);
          return;
        }
      } catch (err: any) {
        this.notify('error', 'Output directory', `Failed to validate the output directory: ${err?.message || err}`);
        this.queueStarted.set(false);
        return;
      }
    }

    this.jobQueue.isProcessing.set(true);
    this.processingInterval = setInterval(() => this.processNextJob(), 1000);
  }

  private async processNextJob(): Promise<void> {
    if (this.jobQueue.hasProcessingJob()) return;

    // A run processes only jobs matching the target locked at Start Queue time, so a
    // transcribe run never sweeps up the 'held' jobs it just created.
    const nextJob =
      this.queueRunTarget === 'held' ? this.jobQueue.getNextHeldJob() : this.jobQueue.getNextPendingJob();

    if (!nextJob) {
      if (this.queueStarted()) {
        this.queueStarted.set(false);
        this.jobQueue.isProcessing.set(false);
        if (this.processingInterval) {
          clearInterval(this.processingInterval);
          this.processingInterval = null;
        }
        // The 14B comes down as soon as the work is done rather than squatting on ~9 GB until
        // the user happens to leave the tab. Best-effort: a failed eviction must not surface as
        // a queue error, and the model is evicted again on leave anyway.
        if (this.runUsedTitleModel) {
          this.runUsedTitleModel = false;
          this.electron.unloadTitleModel().catch(() => {});
        }
      }
      return;
    }

    if (this.queueRunTarget === 'held') {
      await this.sendHeldJob(nextJob, { advanceQueue: true });
    } else if (this.isTitleJob(nextJob)) {
      // "Transcribe only" does not apply: a titling job's prompt is the model's trained
      // contract, not user-reviewable text, and there is nothing to transcribe. A stage-1
      // (pending) run therefore takes titling jobs all the way through — never parks them 'held'.
      await this.runTitleJob(nextJob, { advanceQueue: true });
    } else {
      await this.runJob(nextJob, { showPrompt: this.transcribeOnly(), advanceQueue: true });
    }
  }

  /**
   * Run a single job end-to-end: mark it processing, wire the elapsed timer and the progress
   * listener, call generateMetadata, finalize.
   *
   * With opts.showPrompt the main process transcribes and assembles the prompt but skips the
   * AI call, resolving { held: true, prompts }. In that case the job parks as 'held' and
   * waits for the next Start Queue press.
   */
  private async runJob(job: QueuedJob, opts: { showPrompt?: boolean; advanceQueue?: boolean }): Promise<void> {
    const nextJob = job;

    this.jobQueue.updateJob(nextJob.id, { status: 'processing', progress: 0, currentlyProcessing: 'Starting…' });

    const startTime = Date.now();
    let elapsedInterval: any;
    let unsubscribe: (() => void) | undefined;
    // Guards against finalizing twice: the main process sends a terminal 'complete'/'error'
    // progress event AND the generateMetadata promise resolves. Whichever arrives first
    // finalizes the job; the other is ignored.
    let settled = false;

    try {
      elapsedInterval = setInterval(() => {
        if (!this.jobQueue.getJob(nextJob.id)) return;
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const label =
          elapsed < 60
            ? `Processing… (${elapsed}s)`
            : `Processing… (${Math.floor(elapsed / 60)}m ${elapsed % 60}s)`;
        this.jobQueue.updateJob(nextJob.id, { currentlyProcessing: label });
      }, 1000);

      const totalItems = nextJob.inputs.length;

      // The backend labels progress by filename when it has no index to give.
      const findItemIndexByFilename = (filename: string): number => {
        const cur = this.jobQueue.getJob(nextJob.id);
        if (!cur) return -1;
        const baseFilename = filename.split('/').pop() || filename;
        for (let i = 0; i < cur.inputs.length; i++) {
          if ((cur.inputs[i].path.split('/').pop() || '') === baseFilename) return i;
        }
        return -1;
      };

      // Only one item is ever generated at a time; transcription can be concurrent.
      let generatingItemIndex = -1;

      unsubscribe = this.electron.onMetadataProgress((progress: any) => {
        const cur = this.jobQueue.getJob(nextJob.id);
        if (!cur) return;

        // Terminal events: finalize HERE so the UI can never hang on "generating" if the
        // generateMetadata promise is delayed or lost. The post-await block is skipped once
        // `settled` is set.
        if ((progress.phase === 'complete' || progress.phase === 'error') && !settled) {
          settled = true;
          if (progress.phase === 'complete') {
            for (let i = 0; i < cur.inputs.length; i++) {
              this.jobQueue.updateItemProgress(nextJob.id, i, 100, 'completed');
            }
            const processingTime = (Date.now() - startTime) / 1000;
            this.jobQueue.updateJob(nextJob.id, {
              status: 'completed',
              progress: 100,
              currentlyProcessing: 'Complete',
              completedAt: new Date(),
              processingTime,
            });
            this.notify('success', 'Job complete', `“${nextJob.name}” finished in ${processingTime.toFixed(1)}s`);
          } else {
            cur.itemProgress.forEach((item, i) => {
              if (item.status !== 'completed' && item.status !== 'failed') {
                this.jobQueue.updateItemProgress(nextJob.id, i, 100, 'failed');
              }
            });
            this.jobQueue.updateJob(nextJob.id, {
              status: 'failed',
              progress: 0,
              currentlyProcessing: 'Failed',
              completedAt: new Date(),
              error: progress.message,
            });
            this.notify('error', 'Job failed', `“${nextJob.name}”: ${progress.message || 'Unknown error'}`);
          }
          // Tear down this job's listener/timer and advance now, rather than waiting on the
          // (possibly stuck) promise's finally block.
          if (unsubscribe) unsubscribe();
          if (elapsedInterval) clearInterval(elapsedInterval);
          if (opts.advanceQueue) this.processNextJob();
          return;
        }

        if (progress.phase === 'preparing' && progress.filename) {
          const itemIndex =
            progress.itemIndex !== undefined ? progress.itemIndex : findItemIndexByFilename(progress.filename);
          if (itemIndex >= 0) this.jobQueue.updateItemProgress(nextJob.id, itemIndex, 0, 'transcribing');
          this.jobQueue.updateJob(nextJob.id, { currentlyProcessing: `Processing: ${progress.filename}` });
        }

        if (progress.phase === 'transcription' && progress.percent !== undefined) {
          let itemIndex = progress.itemIndex;
          if (itemIndex === undefined && progress.filename) itemIndex = findItemIndexByFilename(progress.filename);

          if (itemIndex !== undefined && itemIndex >= 0 && itemIndex < totalItems) {
            if (progress.percent === 100) {
              this.jobQueue.updateItemProgress(nextJob.id, itemIndex, 50, 'transcribed');
            } else {
              // Transcription is the first HALF of an item's bar; 0-100 maps to 0-50.
              this.jobQueue.updateItemProgress(nextJob.id, itemIndex, Math.floor(progress.percent / 2), 'transcribing');
            }
            this.jobQueue.updateJob(nextJob.id, {
              currentlyProcessing: progress.message || `Transcribing: ${progress.filename || ''}`,
            });
          }

          const transcribedItems = cur.itemProgress.filter(
            (p) => p.status === 'transcribed' || p.status === 'generating' || p.status === 'completed'
          ).length;
          const transcribingProgress = cur.itemProgress
            .filter((p) => p.status === 'transcribing')
            .reduce((sum, item) => sum + (item.progress || 0), 0);
          const overall = ((transcribedItems + transcribingProgress / 50) / totalItems) * 50;
          this.jobQueue.updateJob(nextJob.id, { progress: Math.min(overall, 49) });
        }

        if (progress.phase === 'generating' && progress.percent !== undefined) {
          const job2 = this.jobQueue.getJob(nextJob.id);

          if (progress.itemIndex !== undefined) {
            const itemIndex = progress.itemIndex;
            if (itemIndex >= 0 && itemIndex < totalItems) {
              // A new item starting at 0% means the previous one is done.
              if (progress.percent === 0 && itemIndex > 0 && job2) {
                if (job2.itemProgress[itemIndex - 1]?.status === 'generating') {
                  this.jobQueue.updateItemProgress(nextJob.id, itemIndex - 1, 100, 'completed');
                }
              }
              // Generation is the second half: 0-100 maps to 50-100.
              this.jobQueue.updateItemProgress(nextJob.id, itemIndex, 50 + Math.floor(progress.percent / 2), 'generating');
              generatingItemIndex = itemIndex;
            }
            if (progress.percent === 100 && itemIndex >= 0) {
              this.jobQueue.updateItemProgress(nextJob.id, itemIndex, 100, 'completed');
            }
          } else {
            // No index from the backend: the next transcribed item is the one generating.
            if (job2) {
              const nextToGenerate = job2.itemProgress.findIndex((p) => p.status === 'transcribed');
              if (nextToGenerate !== -1 && generatingItemIndex !== nextToGenerate) {
                generatingItemIndex = nextToGenerate;
              }
            }
            if (generatingItemIndex >= 0 && generatingItemIndex < totalItems) {
              this.jobQueue.updateItemProgress(
                nextJob.id,
                generatingItemIndex,
                50 + Math.floor(progress.percent / 2),
                'generating'
              );
            }
            if (progress.percent === 100 && generatingItemIndex >= 0) {
              this.jobQueue.updateItemProgress(nextJob.id, generatingItemIndex, 100, 'completed');
              generatingItemIndex = -1;
            }
          }

          this.jobQueue.updateJob(nextJob.id, { currentlyProcessing: progress.message || 'Generating metadata…' });

          if (job2) {
            const completedItems = job2.itemProgress.filter((p) => p.status === 'completed').length;
            const generatingItems = job2.itemProgress.filter((p) => p.status === 'generating').length;
            const currentGenProgress = generatingItems > 0 ? (progress.percent || 0) / 100 : 0;
            const overall = 50 + ((completedItems + currentGenProgress) / totalItems) * 50;
            this.jobQueue.updateJob(nextJob.id, { progress: Math.min(overall, 99) });
          }
        }
      });

      // Text subjects carry their content in textContent; everything else sends its path.
      const inputs = nextJob.inputs.map((item) => ({
        path: this.isTextSubject(item) ? item.textContent || item.path : item.path,
        notes: item.notes,
      }));

      // Chapters are a YouTube-individual concept: a compilation has no single timeline to
      // mark up, and a podcast prompt set has nowhere to put them.
      const chapterFlags: { [path: string]: boolean } = {};
      if (this.isYouTubePromptSet(nextJob.promptSet) && nextJob.mode === 'individual') {
        nextJob.inputs.forEach((item) => {
          if ((item.type === 'video' || item.type === 'transcript-import') && item.generateChapters !== false) {
            chapterFlags[item.path] = true;
          }
        });
      }

      const result = await this.electron.generateMetadata({
        inputs,
        promptSet: nextJob.promptSet,
        mode: nextJob.mode,
        jobId: nextJob.id,
        jobName: nextJob.name,
        chapterFlags,
        showPrompt: opts.showPrompt,
      });

      // Show-prompt path: the main process transcribed, assembled the prompt, is holding the
      // transcript and skipped the AI call. No terminal 'complete' event fires — we key off
      // result.held.
      if (result?.held === true) {
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = undefined;
        }
        if (elapsedInterval) {
          clearInterval(elapsedInterval);
          elapsedInterval = undefined;
        }
        // Chapters run during prompt assembly (they condition the prompt), so this path can
        // carry warnings too — surface them BEFORE the user decides whether to send a prompt
        // that may have been assembled without chapter subjects.
        (result.warnings || []).forEach((w: string) => this.notify('warning', 'Generation warning', w));

        const heldJob = this.jobQueue.getJob(nextJob.id);
        if (heldJob) {
          for (let i = 0; i < heldJob.inputs.length; i++) {
            this.jobQueue.updateItemProgress(nextJob.id, i, 100, 'transcribed');
          }
        }
        this.jobQueue.updateJob(nextJob.id, {
          status: 'held',
          progress: 100,
          currentlyProcessing: 'Transcribed — ready to send',
          heldPrompt: (result.prompts || []).join(`\n\n${'─'.repeat(60)}\n\n`),
        });
        return;
      }

      const processingTime = (Date.now() - startTime) / 1000;

      // Backend warnings (a partial item failure, chapters that could not be built) surface
      // regardless of overall success — a "completed" job can still have lost something.
      (result?.warnings || []).forEach((w: string) => this.notify('warning', 'Generation warning', w));

      if (settled) {
        // Already finalized by the terminal event; just attach output files if they came back.
        if (result?.success && result.output_files) {
          this.jobQueue.updateJob(nextJob.id, { outputFiles: result.output_files });
        }
      } else if (result?.success) {
        const cur = this.jobQueue.getJob(nextJob.id);
        if (cur) {
          for (let i = 0; i < cur.inputs.length; i++) {
            this.jobQueue.updateItemProgress(nextJob.id, i, 100, 'completed');
          }
        }
        this.jobQueue.updateJob(nextJob.id, {
          status: 'completed',
          progress: 100,
          currentlyProcessing: 'Complete',
          completedAt: new Date(),
          outputFiles: result.output_files,
          processingTime,
        });
        this.notify('success', 'Job complete', `“${nextJob.name}” finished in ${processingTime.toFixed(1)}s`);
      } else {
        this.failRemainingItems(nextJob.id);
        this.jobQueue.updateJob(nextJob.id, {
          status: 'failed',
          progress: 0,
          currentlyProcessing: 'Failed',
          completedAt: new Date(),
          error: result?.error,
          processingTime,
        });
        this.notify('error', 'Job failed', `“${nextJob.name}”: ${result?.error}`);
      }
    } catch (error: any) {
      this.notify('error', 'Job failed', `“${nextJob.name}”: ${error?.message || error}`);
      this.failRemainingItems(nextJob.id);
      this.jobQueue.updateJob(nextJob.id, {
        status: 'failed',
        progress: 0,
        currentlyProcessing: 'Error',
        completedAt: new Date(),
        error: String(error?.message || error),
      });
    } finally {
      // Tear down on every path: a finished job's listener would otherwise keep rewriting its
      // progress from the NEXT job's events.
      if (unsubscribe) unsubscribe();
      if (elapsedInterval) clearInterval(elapsedInterval);
      // Advance only when this run owns the queue.
      if (opts.advanceQueue) this.processNextJob();
    }
  }

  /**
   * A job is a TITLING JOB when it is one text subject on its own: individual mode, exactly one
   * input, and that input is a 'subject' — which is what the editor's story handoff produces.
   * Everything else (files, transcripts, compilations) runs the generateMetadata path.
   */
  isTitleJob(job: QueuedJob): boolean {
    return job.mode === 'individual' && job.inputs.length === 1 && job.inputs[0].type === 'subject';
  }

  /**
   * Run a titling job: hand the subject list to the local headline fine-tune and stream the
   * candidates into the row as they land. Sibling of runJob rather than a branch inside it —
   * the two share no machinery beyond the elapsed-time label.
   *
   * No report file, no tags, no description: the candidate list IS the output. A rejection
   * fails the job with the model's own message (a missing `headline-14b-titles` reads as
   * "Ollama HTTP 404: model … not found"); nothing is retried and no other model stands in.
   */
  private async runTitleJob(job: QueuedJob, opts: { advanceQueue?: boolean }): Promise<void> {
    const item = job.inputs[0];
    const format: TitleFormat = item.titleFormat ?? 'normal';
    // Text subjects keep their content in textContent, with path as the dedup mirror of it.
    const text = item.textContent || item.path;

    this.jobQueue.updateJob(job.id, {
      status: 'processing',
      progress: 0,
      currentlyProcessing: 'Starting…',
      titles: [],
      error: undefined,
    });
    this.jobQueue.updateItemProgress(job.id, 0, 0, 'generating');

    const startTime = Date.now();
    this.hasRunTitles = true;
    this.runUsedTitleModel = true;
    this.titleJobId = job.id;
    this.stopRequested = false;

    // Same elapsed-time label as runJob, so a slow title run reads the same as a slow file run.
    const elapsedInterval = setInterval(() => {
      if (!this.jobQueue.getJob(job.id)) return;
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const label =
        elapsed < 60
          ? `Writing titles… (${elapsed}s)`
          : `Writing titles… (${Math.floor(elapsed / 60)}m ${elapsed % 60}s)`;
      this.jobQueue.updateJob(job.id, { currentlyProcessing: label });
    }, 1000);

    // Only one job processes at a time, so one listener for the duration of this job is enough.
    // It is removed in the finally block — a leftover would rewrite the NEXT titling job's row.
    this.electron.onTitlesProgress((p) => {
      const cur = this.jobQueue.getJob(job.id);
      if (!cur || cur.status !== 'processing') return;
      const updates: Partial<QueuedJob> = {};
      if (p.total > 0) {
        const percent = Math.min(99, (p.done / p.total) * 100);
        // Both, deliberately: the queue-wide bar reads job.progress while the row's own bar is
        // computed from itemProgress. Writing only one leaves the other frozen at zero.
        updates.progress = percent;
        this.jobQueue.updateItemProgress(job.id, 0, percent, 'generating');
      }
      // Append rather than replace: the stream is the only place the order is known, and the
      // resolved result below is the final word on the set.
      if (p.title) updates.titles = [...(cur.titles || []), p.title];
      this.jobQueue.updateJob(job.id, updates);
    });

    try {
      const res = await this.electron.generateTitles({
        text,
        format,
        target: TITLE_TARGET,
        count: TITLE_COUNT,
      });
      const processingTime = (Date.now() - startTime) / 1000;
      const titles = res.titles || [];

      if (titles.length === 0) {
        // A run that produced nothing is not a success with an empty list — say so and stop.
        this.jobQueue.updateItemProgress(job.id, 0, 100, 'failed');
        this.jobQueue.updateJob(job.id, {
          status: 'failed',
          progress: 0,
          currentlyProcessing: 'Failed',
          completedAt: new Date(),
          error: 'The model returned no usable titles. Check the Ollama log and try again.',
          processingTime,
        });
        this.notify('error', 'Job failed', `“${job.name}”: the model returned no usable titles.`);
        return;
      }

      this.jobQueue.updateItemProgress(job.id, 0, 100, 'completed');
      this.jobQueue.updateJob(job.id, {
        status: 'completed',
        progress: 100,
        currentlyProcessing: 'Complete',
        completedAt: new Date(),
        processingTime,
        titles,
      });
      this.notify(
        'success',
        'Titles ready',
        `“${job.name}” — ${titles.length} title(s) in ${processingTime.toFixed(1)}s`
      );
    } catch (err: any) {
      const processingTime = (Date.now() - startTime) / 1000;
      const cancelled = this.isStopError(err);
      this.jobQueue.updateItemProgress(job.id, 0, 100, 'failed');
      this.jobQueue.updateJob(job.id, {
        status: 'failed',
        progress: 0,
        currentlyProcessing: cancelled ? 'Cancelled by user' : 'Failed',
        completedAt: new Date(),
        // A cancel is the user's own instruction, not a failure to report as one; whatever had
        // already streamed stays on the row. Everything else surfaces VERBATIM.
        error: cancelled ? 'Job cancelled by user' : String(err?.message || err),
        processingTime,
      });
      if (!cancelled) this.notify('error', 'Job failed', `“${job.name}”: ${err?.message || err}`);
    } finally {
      this.electron.removeTitlesProgressListener();
      clearInterval(elapsedInterval);
      this.titleJobId = null;
      this.stopRequested = false;
      if (opts.advanceQueue) this.processNextJob();
    }
  }

  /** Mark every item that never reached a terminal state as failed — otherwise siblings sit
   *  on 'transcribing'/'generating' forever after the job as a whole has died. */
  private failRemainingItems(jobId: string): void {
    const job = this.jobQueue.getJob(jobId);
    if (!job) return;
    job.itemProgress.forEach((item, i) => {
      if (item.status !== 'completed' && item.status !== 'failed') {
        this.jobQueue.updateItemProgress(jobId, i, 100, 'failed');
      }
    });
  }

  /**
   * Stage 2 of the "Transcribe only" flow: send an already-transcribed ('held') job to the
   * AI, reusing the transcript the main process is holding. No re-transcription.
   */
  private async sendHeldJob(job: QueuedJob, opts: { advanceQueue?: boolean }): Promise<void> {
    const startTime = Date.now();

    // Transcription already ran; the bar starts halfway.
    this.jobQueue.updateJob(job.id, {
      status: 'processing',
      progress: 50,
      currentlyProcessing: 'Generating metadata…',
      heldPrompt: undefined,
    });
    const startJob = this.jobQueue.getJob(job.id);
    if (startJob) {
      for (let i = 0; i < startJob.itemProgress.length; i++) {
        this.jobQueue.updateItemProgress(job.id, i, 50, 'generating');
      }
    }

    let unsubscribe: (() => void) | undefined;

    try {
      // Animate only — finalization comes from the resolved value below.
      unsubscribe = this.electron.onMetadataProgress((progress: any) => {
        if (!this.jobQueue.getJob(job.id)) return;
        if (progress.phase === 'generating' && progress.percent !== undefined) {
          this.jobQueue.updateJob(job.id, {
            currentlyProcessing: progress.message || 'Generating metadata…',
            progress: Math.min(50 + Math.floor((progress.percent || 0) / 2), 99),
          });
        }
      });

      const result = await this.electron.sendHeldPrompt(job.id);
      const processingTime = (Date.now() - startTime) / 1000;

      (result?.warnings || []).forEach((w: string) => this.notify('warning', 'Generation warning', w));

      if (result?.success) {
        const cur = this.jobQueue.getJob(job.id);
        if (cur) {
          for (let i = 0; i < cur.inputs.length; i++) {
            this.jobQueue.updateItemProgress(job.id, i, 100, 'completed');
          }
        }
        this.jobQueue.updateJob(job.id, {
          status: 'completed',
          progress: 100,
          currentlyProcessing: 'Complete',
          completedAt: new Date(),
          outputFiles: result.output_files,
          processingTime,
        });
        this.notify('success', 'Job complete', `“${job.name}” finished in ${processingTime.toFixed(1)}s`);
      } else {
        this.failRemainingItems(job.id);
        this.jobQueue.updateJob(job.id, {
          status: 'failed',
          progress: 0,
          currentlyProcessing: 'Failed',
          completedAt: new Date(),
          error: result?.error,
          processingTime,
        });
        this.notify('error', 'Job failed', `“${job.name}”: ${result?.error}`);
      }
    } catch (error: any) {
      this.notify('error', 'Job failed', `“${job.name}”: ${error?.message || error}`);
      this.failRemainingItems(job.id);
      this.jobQueue.updateJob(job.id, {
        status: 'failed',
        progress: 0,
        currentlyProcessing: 'Error',
        completedAt: new Date(),
        error: String(error?.message || error),
      });
    } finally {
      if (unsubscribe) unsubscribe();
      if (opts.advanceQueue) this.processNextJob();
    }
  }

  // ── Queue rows ─────────────────────────────────────────────────────────────

  toggleJobExpansion(jobId: string): void {
    const expanded = new Set(this.expandedJobIds());
    if (expanded.has(jobId)) expanded.delete(jobId);
    else expanded.add(jobId);
    this.expandedJobIds.set(expanded);
  }

  isJobExpanded(jobId: string): boolean {
    return this.expandedJobIds().has(jobId);
  }

  clearCompletedJobs(): void {
    this.jobQueue.clearCompletedJobs();
  }

  async cancelJob(jobId: string): Promise<void> {
    // A titling job never entered the metadata pipeline, so cancelling it means aborting the
    // Ollama stream. The rejected generateTitles call is what finalizes the row.
    const job = this.jobQueue.getJob(jobId);
    if (job && this.isTitleJob(job)) {
      this.stopRequested = true;
      try {
        await this.electron.cancelTitles();
      } catch (err: any) {
        this.notify('error', 'Cancel failed', err?.message || String(err));
      }
      return;
    }

    try {
      const result = await this.electron.cancelMetadataJob(jobId);
      if (result?.success) {
        this.jobQueue.updateJob(jobId, {
          status: 'failed',
          currentlyProcessing: 'Cancelled by user',
          error: 'Job cancelled by user',
        });
      } else {
        this.notify('error', 'Cancel failed', result?.error || 'Failed to cancel the job.');
      }
    } catch (err: any) {
      this.notify('error', 'Cancel failed', err?.message || String(err));
    }
  }

  removeJob(jobId: string): void {
    // Free any held transcript the main process is keeping for this job so it can't leak.
    const job = this.jobQueue.getJob(jobId);
    if (job?.status === 'held') {
      this.electron.discardHeldPrompt(jobId).catch(() => {});
    }
    this.jobQueue.removeJob(jobId);
  }

  removeItemFromJob(jobId: string, itemIndex: number): void {
    const job = this.jobQueue.getJob(jobId);
    if (!job) return;

    // Build new arrays rather than mutating the signal-held job, and keep inputs /
    // itemProgress spliced in lockstep so the progress math stays sane.
    const newInputs = job.inputs.filter((_, i) => i !== itemIndex);
    if (newInputs.length === 0) {
      this.removeJob(jobId);
      return;
    }
    const newItemProgress = job.itemProgress.filter((_, i) => i !== itemIndex);

    let newCurrentItemIndex = job.currentItemIndex;
    if (newCurrentItemIndex > itemIndex) newCurrentItemIndex -= 1;
    if (newCurrentItemIndex > newItemProgress.length - 1) newCurrentItemIndex = newItemProgress.length - 1;

    this.jobQueue.updateJob(jobId, {
      inputs: newInputs,
      itemProgress: newItemProgress,
      currentItemIndex: newCurrentItemIndex,
    });
  }

  getJobStatusIcon(status: string): string {
    switch (status) {
      case 'pending': return '⏳';
      case 'processing': return '⚙️';
      case 'held': return '⏸️';
      case 'completed': return '✅';
      case 'failed': return '⛔';
      default: return '•';
    }
  }

  getGlobalQueueProgress(): number {
    const jobs = this.jobQueue.jobs();
    if (jobs.length === 0) return 0;
    const total = jobs.reduce(
      (sum, job) => sum + (job.status === 'completed' || job.status === 'failed' ? 100 : job.progress),
      0
    );
    return total / jobs.length;
  }

  getCompletedJobsCount(): number {
    return this.jobQueue.jobs().filter((job) => job.status === 'completed' || job.status === 'failed').length;
  }

  getJobProgress(job: QueuedJob): number {
    if (job.status === 'completed' || job.status === 'failed') return 100;
    if (job.inputs.length === 0) return 0;
    const total = job.itemProgress.reduce((sum, _item, index) => sum + this.getItemProgress(job, index), 0);
    return total / job.inputs.length;
  }

  getCompletedItemsCount(job: QueuedJob): number {
    return job.itemProgress.filter((item) => item.status === 'completed' || item.status === 'failed').length;
  }

  isItemCompleted(job: QueuedJob, itemIndex: number): boolean {
    return job.itemProgress[itemIndex]?.status === 'completed';
  }

  isItemTranscribed(job: QueuedJob, itemIndex: number): boolean {
    return job.itemProgress[itemIndex]?.status === 'transcribed';
  }

  getItemStatusText(job: QueuedJob, itemIndex: number): string {
    const item = job.itemProgress[itemIndex];
    switch (item?.status) {
      case 'transcribing':
        // Progress is stored as 0-50 (half the bar), so double it for the transcription %.
        return `Transcribing ${Math.min(100, (item?.progress || 0) * 2)}%`;
      case 'transcribed': return 'Transcribed';
      case 'generating': return 'Generating…';
      case 'completed': return 'Completed';
      case 'failed': return 'Failed';
      default: return 'Pending';
    }
  }

  getItemStatusClass(job: QueuedJob, itemIndex: number): string {
    return job.itemProgress[itemIndex]?.status || 'pending';
  }

  getItemProgress(job: QueuedJob, itemIndex: number): number {
    const item = job.itemProgress[itemIndex];
    if (!item) return 0;
    if (item.status === 'completed' || item.status === 'failed') return 100;
    if (item.status === 'transcribed') return 50;
    if (item.status === 'transcribing' || item.status === 'generating') return item.progress;
    return 0;
  }

  trackByJobId(_index: number, job: QueuedJob): string {
    return job.id;
  }

  trackByItemPath(_index: number, item: InputItem): string {
    return item.path;
  }

  trackByIndex(index: number): number {
    return index;
  }

  // ── Title candidates in a job row ──────────────────────────────────────────

  /** The band a job's candidates are judged against: the item's format, 'normal' by default. */
  private titleFormatOf(job: QueuedJob): TitleFormat {
    return job.inputs[0]?.titleFormat ?? 'normal';
  }

  /** Advisory only — a title outside the trained band still generated, it is just off-pattern. */
  isTitleInBand(job: QueuedJob, title: string): boolean {
    const r = LENGTH_RANGE[this.titleFormatOf(job)];
    return title.length >= r.min && title.length <= r.max;
  }

  titleBandHint(job: QueuedJob): string {
    const r = LENGTH_RANGE[this.titleFormatOf(job)];
    return `${r.min}–${r.max} characters`;
  }

  isCandidateCopied(jobId: string, index: number): boolean {
    return this.copiedKey === `${jobId}:${index}`;
  }

  async copyCandidate(job: QueuedJob, index: number): Promise<void> {
    const title = job.titles?.[index];
    if (!title) return;
    try {
      await navigator.clipboard.writeText(title);
      this.copiedKey = `${job.id}:${index}`;
      if (this.copyTimer !== null) clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => {
        this.copiedKey = null;
        this.copyTimer = null;
      }, 1400);
    } catch (err: any) {
      this.notify('error', 'Copy', `Could not copy to the clipboard: ${err?.message || err}`);
    }
  }

  // ── Editor handoff ─────────────────────────────────────────────────────────

  /**
   * Subject lists handed over from the timeline editor — one handoff per story, because each
   * story is its own upload. Every one lands in the item list as a text subject: the same
   * chapter list is the input to both halves of this page and it would be perverse to make the
   * user retype it. Queueing such an item runs the titling model on it.
   */
  private applyHandoffs(hs: TitleHandoff[]): void {
    const usable = (hs || []).filter((h) => h?.subjects?.length);
    if (!usable.length) return;

    // Counted from the list itself, not from usable.length: addItem dedups by path, so a story
    // whose subject list is already in the list adds nothing and must not be reported as added.
    const before = this.inputsState.inputItems().length;
    for (const h of usable) {
      const text = h.subjects.join('\n');
      this.inputsState.addItem({
        type: 'subject',
        path: text,
        displayName: h.source ? `Chapters — ${h.source}` : this.shortLabel(h.subjects[0]),
        icon: '🎞️',
        selected: true,
        promptSet: this.inputsState.masterPromptSet(),
        textContent: text,
        // Carried so a livestream send is still titled as a livestream when its job runs.
        titleFormat: h.format === 'livestream' ? 'livestream' : 'normal',
      });
    }
    const added = this.inputsState.inputItems().length - before;
    const skipped = usable.length - added;

    this.notify(
      'success',
      'Stories added',
      skipped === 0
        ? `${added} ${added === 1 ? 'story' : 'stories'} added to the item list.`
        : `${added} of ${usable.length} ${usable.length === 1 ? 'story' : 'stories'} added to the ` +
          `item list — ${skipped} ${skipped === 1 ? 'was' : 'were'} already in it.`
    );
  }

  /**
   * True when a rejection is really the user's own Cancel. The abort surfaces as
   * OllamaCancelledError, but IPC flattens it to a message string ("Error invoking remote
   * method 'titles:generate': OllamaCancelledError: Cancelled."), so the message is what we
   * can actually match on — the same test the editor's analysis loop uses.
   */
  private isStopError(err: any): boolean {
    const msg = String(err?.message || err || '');
    return this.stopRequested || err?.name === 'OllamaCancelledError' || /OllamaCancelledError/.test(msg);
  }
}
