import {
  Component, EventEmitter, HostBinding, Input, OnDestroy, Output
} from '@angular/core';
import { ActivityEntry } from '../model/editor-types';

/**
 * The editor's floating background-activity HUD (FCPX-style): a draggable dock listing whatever
 * is in flight — transcription, export, waveform extraction, the story-analysis queue — or
 * nothing at all.
 *
 * Deliberately dumb. It owns exactly one thing: the header drag gesture. Every number it renders
 * is an Input, every button emits an Output, and the shell decides what stopping or skipping
 * actually does. In particular the dock does NOT own its position: `x`/`y` live in the editor so
 * the dock reopens where the user left it (child-owned coordinates would recenter it on every
 * close/reopen, since the host is behind an *ngIf).
 */
@Component({
  selector: 'app-editor-activity-dock',
  templateUrl: './activity-dock.component.html',
  styleUrls: ['./activity-dock.component.scss'],
  standalone: false
})
export class ActivityDockComponent implements OnDestroy {
  /** Drag offsets from the dock's default top-center anchor, owned by the shell. */
  @Input() x = 0;
  @Input() y = 0;

  @Input() transcribing = false;      // transcriptState === 'running'
  @Input() transcribeProgress = 0;
  @Input() transcribeMessage = '';
  @Input() transcribeEtaLabel = '';

  @Input() exporting = false;

  @Input() waveformActive = false;
  @Input() waveformPct = 0;
  @Input() peaksBurstDone = 0;
  @Input() peaksBurstTotal = 0;

  @Input() analyzing = false;
  @Input() analyzeMessage = '';
  @Input() analyzeError: string | null = null;
  @Input() aiPhase = '';
  @Input() aiProgressTotal = 0;
  @Input() aiProgressPct = 0;

  /** The whole story-analysis queue; index 0 is what is running now. */
  @Input() queue: ActivityEntry[] = [];
  /** The waiting rows the dock is allowed to list (already capped by the shell). */
  @Input() pending: ActivityEntry[] = [];
  @Input() pendingMore = 0;
  @Input() hasBackgroundActivity = false;

  @Output() closed = new EventEmitter<void>();
  @Output() moved = new EventEmitter<{ x: number; y: number }>();
  @Output() stopRequested = new EventEmitter<void>();
  @Output() skipRunningRequested = new EventEmitter<void>();
  @Output() cancelPendingRequested = new EventEmitter<string>();

  /** Anchored top-center; the drag offset rides on top of the -50% centering translate. */
  @HostBinding('style.transform') get transform(): string {
    return 'translate(calc(-50% + ' + this.x + 'px), ' + this.y + 'px)';
  }

  /** The story being worked on right now (=== the editor's activityRunning). */
  get running(): ActivityEntry | null {
    return this.queue[0] ?? null;
  }

  private activityDragBase: { x: number; y: number; dx: number; dy: number } | null = null;

  /** Begin dragging the Activity dock (grab its header; ignore clicks on the × button). */
  onActivityDragStart(ev: MouseEvent): void {
    if ((ev.target as HTMLElement)?.tagName === 'BUTTON') return;
    ev.preventDefault();
    this.activityDragBase = { x: ev.clientX, y: ev.clientY, dx: this.x, dy: this.y };
    window.addEventListener('mousemove', this.onActivityDragMove);
    window.addEventListener('mouseup', this.onActivityDragEnd);
  }
  private onActivityDragMove = (ev: MouseEvent): void => {
    if (!this.activityDragBase) return;
    this.moved.emit({
      x: this.activityDragBase.dx + (ev.clientX - this.activityDragBase.x),
      y: this.activityDragBase.dy + (ev.clientY - this.activityDragBase.y),
    });
  };
  private onActivityDragEnd = (): void => {
    this.activityDragBase = null;
    window.removeEventListener('mousemove', this.onActivityDragMove);
    window.removeEventListener('mouseup', this.onActivityDragEnd);
  };

  /**
   * The dock can be destroyed mid-drag — `resetSessionState()` closes it while the pointer is
   * still down — so the window listeners have to come off here as well as in onActivityDragEnd.
   */
  ngOnDestroy(): void {
    window.removeEventListener('mousemove', this.onActivityDragMove);
    window.removeEventListener('mouseup', this.onActivityDragEnd);
  }
}
