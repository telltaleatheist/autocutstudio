import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { Subject, Subscription } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { ElectronService } from '../../services/electron.service';
import { ProcessingService } from '../../services/processing.service';
import { AudioSource, AudioSourceType, VideoSourceType, MediaSourceType, AUDIO_SOURCE_LABELS, VIDEO_SOURCE_LABELS, MEDIA_SOURCE_LABELS } from '../../models/types';

@Component({
  selector: 'app-workflow',
  standalone: false,
  templateUrl: './workflow.component.html',
  styleUrl: './workflow.component.scss'
})
export class WorkflowComponent implements OnInit, OnDestroy {
  private destroy$ = new Subject<void>();
  // Master video
  masterVideoPath = '';

  // Media sources (both audio and video)
  audioSources: AudioSource[] = [];
  audioSourceLabels = AUDIO_SOURCE_LABELS;
  videoSourceLabels = VIDEO_SOURCE_LABELS;
  mediaSourceLabels = MEDIA_SOURCE_LABELS;
  audioTypes: AudioSourceType[] = ['mic1', 'mic2', 'mic3', 'mic4', 'screen', 'game', 'soundEffects', 'bluetooth', 'mic1Sb', 'mic2Sb', 'mic3Sb', 'mic4Sb', 'screenSb', 'desktopSb', 'gameSb', 'bluetoothSb', 'soundEffectsSb'];
  videoTypes: VideoSourceType[] = ['cam1', 'cam2', 'screenVideo', 'gameVideo'];
  allMediaTypes: MediaSourceType[] = [...this.audioTypes, ...this.videoTypes];

  // Video sources (optional)
  videoSources = {
    cam1: '',
    cam2: '',
    screen: '',
    game: ''
  };

  // Audio corrections
  globalDriftFrames = 0;

  // Auto ducking (Dugan automixer) - enabled by default
  autoDuck = true;

  // Voice isolation (audio-separator) — isolate the speaker's voice on mic1/mic2
  // before alignment. Install-gated: the toggle only appears once the optional
  // 'voice-separator-env' component is installed; until then we show an Install
  // affordance. Defaults CHECKED so it's on by default once available.
  denoiseMics = true;
  separatorInstalled = false;
  separatorStatus: any = null;        // ComponentStatus for size/state
  separatorInstalling = false;
  separatorInstallPct = 0;
  separatorInstallPhase = '';
  separatorInstallMessage = '';
  separatorError = '';

  // Stream recovery mode - use downloaded stream as master
  useDownloadedStream = false;

  // Manual alignment: when checked, clicking Process first measures per-source offsets,
  // then opens the alignment wizard (a second window) PAUSING the run until the user
  // finishes (their nudged values become alignmentOverrides) or cancels (aborts the run).
  // The wizard covers these normalized audio types; everything else stays automatic.
  private static readonly WIZARD_AUDIO_TYPES = ['mic1', 'mic2', 'screen'];
  alignManually = false;
  measuringAlignment = false;   // busy: GCC-PHAT measurement in flight
  awaitingAlignment = false;    // busy: wizard window open, waiting for the user

  // Manual alignment overrides (Phase 1 plumbing). Optional per-source structure the
  // future manual-alignment UI populates; when set, it flows unchanged through the IPC
  // layer into the Python pipeline, which skips GCC-PHAT for those sources and uses the
  // supplied offset verbatim. Shape: { audio?: { <type>: { offsetSeconds, driftFactor } },
  // video?: { <type>: { offsetSeconds, driftFactor } } }. Null => full auto (no change).
  alignmentOverrides: { audio?: { [key: string]: { offsetSeconds: number; driftFactor?: number } };
                        video?: { [key: string]: { offsetSeconds: number; driftFactor?: number } } } | null = null;

  // Processing
  isProcessing = false;
  // Synchronous re-entrancy guard for processWorkflow(). isProcessing only flips
  // once the running job propagates back through the async subscription, leaving a
  // window where a double-click could start a second Python process.
  private isStartingWorkflow = false;
  consoleOutput: string[] = [];
  currentJobId = '';
  currentProgress = 0;
  currentMessage = '';

  // Skip functionality
  currentOperation = '';
  canSkipCurrent = false;
  subProgress = 0;
  skipDecisions: any = null;

  // Time estimation
  operationStartTime: number | null = null;
  estimatedTimeRemaining = '';
  private lastProgressUpdate = 0;
  private lastProgressTime = 0;

  // File browser
  showFileBrowser = false;
  fileBrowserMode: 'master' | 'audio' | 'videoSource' = 'master';
  fileBrowserTarget = '';

  constructor(
    private electronService: ElectronService,
    private processingService: ProcessingService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit() {
    // Determine whether the optional voice-isolation component is installed, and
    // wire up install-progress updates for its Install affordance.
    void this.refreshSeparatorStatus();
    this.electronService.onAssetProgress((p) => this.onSeparatorProgress(p));

    // Subscribe to processing updates (auto-cleaned up on destroy)
    this.processingService.getCurrentJob().pipe(takeUntil(this.destroy$)).subscribe(job => {
      if (job) {
        this.isProcessing = job.status === 'running';
        this.consoleOutput = job.output;
        this.currentJobId = job.id;
        this.currentProgress = job.progress;
        this.currentMessage = job.message;

        // Track operation changes and reset time estimation
        const previousOperation = this.currentOperation;
        this.currentOperation = job.currentOperation || '';

        // Reset time tracking when operation changes
        if (this.currentOperation && this.currentOperation !== previousOperation) {
          this.operationStartTime = Date.now();
          this.lastProgressUpdate = job.subProgress || 0;
          this.lastProgressTime = Date.now();
          this.estimatedTimeRemaining = 'Calculating...';
        }

        // Skip functionality
        this.canSkipCurrent = job.canSkipCurrent || false;
        const newSubProgress = job.subProgress || 0;

        // Update time estimation when progress changes
        if (this.currentOperation && newSubProgress !== this.subProgress && newSubProgress > 0) {
          this.updateTimeEstimate(newSubProgress);
        }

        this.subProgress = newSubProgress;
        this.skipDecisions = job.skipDecisions;
      } else {
        this.isProcessing = false;
        this.operationStartTime = null;
        this.estimatedTimeRemaining = '';
      }
      // Force change detection for updates from outside Angular zone (Electron IPC)
      this.cdr.detectChanges();
    });
  }

  ngOnDestroy() {
    this.electronService.removeAssetProgressListener();
    this.destroy$.next();
    this.destroy$.complete();
  }

  /**
   * Load the install state of the optional voice-isolation component so the
   * template can show either the toggle (installed) or the Install card.
   */
  private async refreshSeparatorStatus(): Promise<void> {
    try {
      const res = await this.electronService.listAssets();
      const comp = (res.components || []).find((c: any) => c.id === 'voice-separator-env');
      this.separatorStatus = comp || null;
      this.separatorInstalled = !!comp && comp.state === 'installed';
    } catch (error) {
      console.error('Error loading voice-isolation status:', error);
      this.separatorInstalled = false;
    } finally {
      this.cdr.detectChanges();
    }
  }

  /** Human-readable download size for the Install card (e.g. "~1.1 GB"). */
  get separatorSizeLabel(): string {
    const bytes = this.separatorStatus?.sizeBytes || 0;
    if (!bytes) return '~1.1 GB';
    return `~${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  }

  /** True when a published artifact exists for this platform (installable now). */
  get separatorInstallable(): boolean {
    return this.separatorStatus?.installable !== false;
  }

  /**
   * Download + install the voice-isolation component. Progress is delivered via
   * onAssetProgress (onSeparatorProgress). On success the toggle replaces the
   * Install card.
   */
  async installSeparator(): Promise<void> {
    if (this.separatorInstalling) return;
    this.separatorInstalling = true;
    this.separatorError = '';
    this.separatorInstallPct = 0;
    this.separatorInstallPhase = 'resolve';
    this.separatorInstallMessage = 'Preparing…';
    this.cdr.detectChanges();

    try {
      const result = await this.electronService.installAsset('voice-separator-env');
      if (result && result.ok) {
        this.separatorInstalled = true;
        this.denoiseMics = true;   // default checked once available
        await this.refreshSeparatorStatus();
      } else {
        this.separatorError = result?.error || 'Install failed. Check your connection and retry.';
      }
    } catch (error: any) {
      this.separatorError = error?.message || 'Install failed unexpectedly.';
    } finally {
      this.separatorInstalling = false;
      this.cdr.detectChanges();
    }
  }

  /** Handle install progress events for the voice-isolation component only. */
  private onSeparatorProgress(p: any): void {
    if (!p || p.id !== 'voice-separator-env') return;
    this.separatorInstallPhase = p.phase || '';
    if (typeof p.pct === 'number') this.separatorInstallPct = p.pct;
    this.separatorInstallMessage = p.message || this.separatorPhaseLabel(p.phase);
    if (p.phase === 'done') {
      this.separatorInstallPct = 100;
    } else if (p.phase === 'error') {
      this.separatorError = p.message || 'Install failed.';
    }
    this.cdr.detectChanges();
  }

  separatorPhaseLabel(phase: string): string {
    switch (phase) {
      case 'download': return 'Downloading…';
      case 'verify': return 'Verifying…';
      case 'extract': return 'Extracting…';
      case 'postinstall': return 'Finalizing…';
      case 'done': return 'Ready';
      case 'error': return 'Error';
      default: return 'Preparing…';
    }
  }

  // Master video selection
  async selectMasterVideo() {
    try {
      const result = await this.electronService.selectFile({
        title: 'Select Master Video File',
        filters: [
          { name: 'Video Files', extensions: ['mp4', 'mov', 'avi', 'mkv', 'flv', 'wmv', 'mpg', 'mpeg', 'm4v', 'webm'] }
        ]
      });

      if (!result.canceled && result.filePaths.length > 0) {
        this.masterVideoPath = result.filePaths[0];
      }
    } catch (error) {
      console.error('Error selecting master video:', error);
      alert('Error selecting file: ' + error);
    }
  }

  // Media source management (audio or video)
  async addAudioSource() {
    try {
      const result = await this.electronService.selectFile({
        title: 'Select Audio or Video File',
        filters: [
          { name: 'All Media Files', extensions: ['wav', 'mp3', 'aac', 'flac', 'ogg', 'm4a', 'mp4', 'mov', 'avi', 'mkv'] },
          { name: 'Audio Files', extensions: ['wav', 'mp3', 'aac', 'flac', 'ogg', 'm4a'] },
          { name: 'Video Files', extensions: ['mp4', 'mov', 'avi', 'mkv'] }
        ]
      });

      if (!result.canceled && result.filePaths.length > 0) {
        const path = result.filePaths[0];
        const fileName = path.split('/').pop() || '';
        const isVideo = /\.(mp4|mov|avi|mkv)$/i.test(path);

        const audioSource: AudioSource = {
          id: `media_${Date.now()}`,
          path,
          name: fileName,
          type: '',
          syncFix: false,
          applyDrift: false,
          isVideo
        };

        this.audioSources.push(audioSource);
      }
    } catch (error) {
      console.error('Error adding media source:', error);
      alert('Error selecting file: ' + error);
    }
  }

  removeAudioSource(id: string) {
    this.audioSources = this.audioSources.filter(s => s.id !== id);
  }

  // Auto-detect audio and video files
  async autoDetectAudioFiles() {
    if (!this.masterVideoPath) {
      return;
    }

    try {
      const result = await this.electronService.autoDetectAudio(this.masterVideoPath);

      if (result.success) {
        const audioFiles = result.audioFiles || {};
        const videoFiles = result.videoFiles || {};

        // Clear existing sources
        this.audioSources = [];

        // Add detected audio files (backend returns camelCase keys directly)
        for (const [audioType, audioPath] of Object.entries(audioFiles)) {
          const fileName = audioPath.split('/').pop() || '';
          const audioSource: AudioSource = {
            id: `audio_${Date.now()}_${audioType}`,
            path: audioPath,
            name: fileName,
            type: audioType as AudioSourceType,
            syncFix: false,
            applyDrift: false,
            isVideo: false
          };
          this.audioSources.push(audioSource);
        }

        // Add detected video files (backend returns camelCase keys directly)
        for (const [videoType, videoPath] of Object.entries(videoFiles)) {
          if (typeof videoPath === 'string') {
            const fileName = videoPath.split('/').pop() || '';
            const videoSource: AudioSource = {
              id: `video_${Date.now()}_${videoType}`,
              path: videoPath,
              name: fileName,
              type: videoType as VideoSourceType,
              syncFix: false,
              applyDrift: false,
              isVideo: true
            };
            this.audioSources.push(videoSource);
          }
        }
      }
    } catch (error) {
      console.error('Error auto-detecting media:', error);
    }
  }

  getAvailableAudioTypes(currentType: string): MediaSourceType[] {
    const usedTypes = this.audioSources
      .filter(s => s.type && s.type !== currentType)
      .map(s => s.type as MediaSourceType);
    return this.allMediaTypes.filter(type => !usedTypes.includes(type));
  }

  /**
   * Get sorted media sources: audio sources first, then soundboard audio, then video sources
   */
  get sortedAudioSources(): AudioSource[] {
    return [...this.audioSources].sort((a, b) => {
      // Helper to determine category: 0 = audio, 1 = soundboard, 2 = video
      const getCategory = (source: AudioSource): number => {
        if (source.isVideo) return 2; // Video sources last
        if (source.type && source.type.toString().endsWith('Sb')) return 1; // Soundboard audio second
        return 0; // Regular audio first
      };

      const categoryA = getCategory(a);
      const categoryB = getCategory(b);

      return categoryA - categoryB;
    });
  }

  // Video source selection
  async selectVideoSource(sourceType: 'cam1' | 'cam2' | 'screen' | 'game') {
    try {
      const result = await this.electronService.selectFile({
        title: `Select ${sourceType} Video`,
        filters: [
          { name: 'Video Files', extensions: ['mp4', 'mov', 'avi', 'mkv'] }
        ]
      });

      if (!result.canceled && result.filePaths.length > 0) {
        this.videoSources[sourceType] = result.filePaths[0];
      }
    } catch (error) {
      console.error('Error selecting video source:', error);
      alert('Error selecting file: ' + error);
    }
  }

  clearVideoSource(sourceType: 'cam1' | 'cam2' | 'screen' | 'game') {
    this.videoSources[sourceType] = '';
  }

  // Process workflow
  async processWorkflow() {
    // Synchronous re-entrancy guard — must run before any await so a rapid
    // double-click can't spawn a second workflow and orphan the first process.
    if (this.isProcessing || this.isStartingWorkflow) {
      return;
    }
    this.isStartingWorkflow = true;

    try {
      // Validation - just return silently, button is disabled when invalid
      if (!this.masterVideoPath) {
        alert('Please select a master video.');
        return;
      }

      // Check if all audio sources have types assigned (only if there are audio sources)
      if (this.audioSources.length > 0) {
        const unassignedAudio = this.audioSources.filter(s => !s.type);
        if (unassignedAudio.length > 0) {
          alert('Please assign types to all audio sources.');
          return;
        }
      }

      // Build audio and video sources objects
      const audioSourcesObj: { [key: string]: string } = {};
      const audioSyncSettings: { [key: string]: boolean } = {};
      const videoSourcesObj: { [key: string]: string } = {};

      this.audioSources.forEach(source => {
        if (source.type) {
          if (source.isVideo) {
            // Map video source types (screenVideo/gameVideo -> screen/game for compound generators)
            const typeMap: { [key: string]: string } = {
              'screenVideo': 'screen',
              'gameVideo': 'game'
            };
            const backendType = typeMap[source.type] || source.type;
            videoSourcesObj[backendType] = source.path;
          } else {
            // Audio source - send camelCase directly to Python
            audioSourcesObj[source.type] = source.path;
            audioSyncSettings[source.type] = source.syncFix || source.applyDrift;
          }
        }
      });

      // Merge video sources from both the dedicated videoSources object and the audioSources array
      const mergedVideoSources = { ...this.videoSources, ...videoSourcesObj };

      // Build options
      const options = {
        masterVideo: this.masterVideoPath,
        audioSources: audioSourcesObj,
        audioSyncSettings,
        videoSources: mergedVideoSources,
        autoDuck: this.autoDuck,
        denoiseMics: this.separatorInstalled && this.denoiseMics,
        useDownloadedStream: this.useDownloadedStream,
        // Phase 1: carry manual overrides through untouched (null => full auto).
        alignmentOverrides: this.alignmentOverrides
      };

      // Manual alignment: measure → open wizard → wait. Cancel/failure aborts the
      // whole run (loud, no partial run); finishing feeds nudged values as overrides.
      if (this.alignManually) {
        const overrides = await this.runManualAlignment(options);
        if (!overrides) {
          return; // measurement failed, window failed to open, or user cancelled
        }
        this.alignmentOverrides = overrides;
        options.alignmentOverrides = overrides;
      }

      // Start workflow
      await this.processingService.startWorkflow(options);
    } catch (error) {
      console.error('Error starting workflow:', error);
      alert('Error starting workflow: ' + error);
    } finally {
      // Always release the guard. By now a successful start has already set the
      // running job (so isProcessing keeps the button disabled); on any early
      // return or failure this re-enables the action.
      this.isStartingWorkflow = false;
    }
  }

  /**
   * Measure per-source offsets, open the alignment wizard, and wait for the result.
   * Returns the alignmentOverrides ({ audio: {...} }) on Finish, or null when the
   * measurement fails / the window can't open / the user cancels (run must abort).
   */
  private async runManualAlignment(options: any): Promise<{ audio?: any; video?: any } | null> {
    // 0. Scope check BEFORE any slow measurement. The wizard covers the raw sources
    // the user manually shifts (mic1/mic2/screen audio); other audio types stay on
    // the automatic path. Soundboard (Sb) variants are synced by the UNIFIED
    // soundboard path, which cannot take per-source overrides — the pipeline would
    // abort loudly AFTER the user finished the whole wizard, so refuse up front.
    const sbBlocked = this.audioSources.find(
      s => !s.isVideo && !!s.type && (s.type as string).endsWith('Sb')
        && WorkflowComponent.WIZARD_AUDIO_TYPES.includes((s.type as string).replace('Sb', ''))
    );
    if (sbBlocked) {
      alert(`Manual alignment doesn't support soundboard sources yet (${sbBlocked.type}). ` +
            `Remove the soundboard source or uncheck "Align manually".`);
      return null;
    }

    // 1. Measure (GCC-PHAT over every source — slow; show a clear busy state).
    this.measuringAlignment = true;
    this.cdr.detectChanges();
    let measure: { success: boolean; sources?: { audio: any; video: any }; error?: string };
    try {
      measure = await this.electronService.measureAlignment(options);
    } catch (error: any) {
      alert('Alignment measurement failed: ' + (error?.message || error));
      return null;
    } finally {
      this.measuringAlignment = false;
      this.cdr.detectChanges();
    }
    if (!measure?.success || !measure.sources) {
      alert('Alignment measurement failed: ' + (measure?.error || 'unknown error'));
      return null;
    }

    // 2. Build the wizard seed payload (measured offsets + resolved file paths).
    // Only wizard-scoped types are included; the rest keep the automatic path
    // (documented behavior: sources without overrides are auto-aligned as today).
    const audioMeasures = measure.sources.audio || {};
    const audio: { [k: string]: any } = {};
    for (const normType of Object.keys(audioMeasures)) {
      if (!WorkflowComponent.WIZARD_AUDIO_TYPES.includes(normType)) continue;
      const filePath = this.pathForNormalizedAudio(normType);
      if (!filePath) continue;
      const m = audioMeasures[normType];
      audio[normType] = {
        path: filePath,
        offsetSeconds: m.offsetSeconds,
        confidence: m.confidence,
        trusted: m.trusted
      };
    }
    if (Object.keys(audio).length === 0) {
      alert('No audio sources available to align.');
      return null;
    }

    // 3. Wire the result wait BEFORE opening so no event is missed, then open.
    const waitPromise = this.waitForAlignment();
    this.awaitingAlignment = true;
    this.cdr.detectChanges();
    const open = await this.electronService.openAlignment({ masterVideo: this.masterVideoPath, audio });
    if (!open?.success) {
      this.awaitingAlignment = false;
      this.cdr.detectChanges();
      alert('Could not open the alignment window: ' + (open?.error || 'unknown error'));
      return null;
    }

    const result = await waitPromise;
    this.awaitingAlignment = false;
    this.cdr.detectChanges();
    if (!result) {
      // Cancelled (or window closed) — abort the run, no partial processing.
      return null;
    }
    return result.overrides || {};
  }

  /** First non-video source whose normalized type (Sb stripped) matches. */
  private pathForNormalizedAudio(normType: string): string | null {
    const match = this.audioSources.find(
      s => !s.isVideo && !!s.type && (s.type as string).replace('Sb', '') === normType
    );
    return match ? match.path : null;
  }

  /** Resolve exactly once on wizard complete (overrides) or cancel (null). */
  private waitForAlignment(): Promise<{ overrides: any } | null> {
    return new Promise((resolve) => {
      const subs: Subscription[] = [];
      const settle = (val: { overrides: any } | null) => {
        subs.forEach(s => s.unsubscribe());
        resolve(val);
      };
      subs.push(this.electronService.getAlignmentComplete().subscribe(d => settle({ overrides: d.overrides })));
      subs.push(this.electronService.getAlignmentCancelled().subscribe(() => settle(null)));
    });
  }

  // Cancel job
  async cancelJob() {
    if (confirm('Are you sure you want to cancel the current job?')) {
      await this.processingService.cancelJob();
    }
  }

  async skipCurrentOperation() {
    console.log('[SKIP] Button clicked, canSkipCurrent:', this.canSkipCurrent);
    if (!this.canSkipCurrent) {
      console.log('[SKIP] Cannot skip - button disabled');
      return;
    }
    try {
      console.log('[SKIP] Sending skip signal...');
      await this.electronService.sendSkipSignal();
      console.log('[SKIP] Skip signal sent successfully');
    } catch (error) {
      console.error('[SKIP] Error sending skip signal:', error);
    }
  }

  /**
   * Update estimated time remaining based on progress rate
   */
  private updateTimeEstimate(currentProgress: number): void {
    const now = Date.now();

    // Need at least 1% progress and 2 seconds elapsed for a reasonable estimate
    if (currentProgress < 1 || !this.operationStartTime || (now - this.operationStartTime) < 2000) {
      this.estimatedTimeRemaining = 'Calculating...';
      return;
    }

    // Use the AVERAGE rate over the whole operation, not an instantaneous
    // point-to-point rate. The old instantaneous rate spiked to a bogus tiny
    // ETA whenever two updates arrived close together — e.g. an instant
    // silent-section passthrough finishing right after a slow section — which
    // caused the "24s remaining at 20%" glitch. Averaging over elapsed time is
    // smooth and self-correcting.
    this.lastProgressUpdate = currentProgress;
    this.lastProgressTime = now;

    const elapsedSeconds = (now - this.operationStartTime) / 1000;
    const avgRate = currentProgress / elapsedSeconds; // percent per second
    if (avgRate <= 0 || !isFinite(avgRate)) {
      this.estimatedTimeRemaining = 'Calculating...';
      return;
    }
    const remainingSeconds = (100 - currentProgress) / avgRate;
    this.estimatedTimeRemaining = this.formatTimeRemaining(remainingSeconds);
  }

  /**
   * Format seconds into human-readable time string
   */
  private formatTimeRemaining(seconds: number): string {
    if (seconds < 0 || !isFinite(seconds)) {
      return 'Calculating...';
    }

    if (seconds < 60) {
      return `${Math.round(seconds)}s remaining`;
    } else if (seconds < 3600) {
      const minutes = Math.floor(seconds / 60);
      const secs = Math.round(seconds % 60);
      return `${minutes}m ${secs}s remaining`;
    } else {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return `${hours}h ${minutes}m remaining`;
    }
  }
}
