import { Component, EventEmitter, OnDestroy, OnInit, Output } from '@angular/core';
import { ElectronService } from '../../services/electron.service';

interface SetupItem {
  id: string;
  name: string;
  description: string;
  pct: number;
  phase: string;
  message: string;
  done: boolean;
}

/**
 * First-run dependency installer — NON-blocking. If any required downloadable asset
 * (ffmpeg/ffprobe, Python runtime, the Whisper speech model) is missing, the user first
 * sees a small APPROVAL prompt ("Missing some dependencies… [OK]"). OK releases the app
 * immediately (`complete` fires) and the download runs in the background, shown in a
 * floating dock pinned bottom-right that can be dragged anywhere or dismissed (the
 * install keeps running in the main process either way). Features that need a missing
 * component (transcription) simply fail with a clear message until it lands.
 */
@Component({
  selector: 'app-setup',
  standalone: false,
  template: `
    <!-- Phase 1: approval prompt (the only blocking moment, and only until OK). -->
    <div class="setup-overlay" *ngIf="state === 'approval'">
      <div class="setup-card">
        <div class="setup-logo">🎬</div>
        <h1 class="setup-title">Missing some dependencies</h1>
        <p class="setup-sub">
          AutoCutStudio needs to install
          {{ hasModel ? 'speech-recognition software' : 'required components' }}
          ({{ totalLabel }}). It downloads in the background — you can keep using the app,
          but transcription features wait until it finishes.
        </p>
        <div class="setup-actions">
          <button class="btn-primary" (click)="approve()">OK</button>
        </div>
      </div>
    </div>

    <!-- Phase 2: floating download dock (drag by its header; × hides it, install continues). -->
    <div class="dl-dock" *ngIf="state === 'installing' && !dockDismissed"
         [style.transform]="'translate(' + dockX + 'px,' + dockY + 'px)'">
      <div class="dl-head" (mousedown)="onDockDragStart($event)">
        <span class="dl-title">{{ error ? 'Install failed' : 'Installing dependencies…' }}</span>
        <button class="dl-close" (click)="dockDismissed = true" title="Hide (install continues)">×</button>
      </div>
      <div class="dl-items" *ngIf="!error">
        <div class="dl-item" *ngFor="let it of items">
          <div class="item-row">
            <span class="item-name">{{ it.name }}</span>
            <span class="item-status">{{ it.done ? 'Ready' : (it.message || phaseLabel(it.phase)) }}</span>
          </div>
          <div class="bar"><div class="bar-fill" [class.done]="it.done"
               [style.width.%]="it.done ? 100 : it.pct"></div></div>
        </div>
      </div>
      <div class="dl-error" *ngIf="error">
        <p>{{ error }}</p>
        <button class="btn-primary" (click)="retry()">Retry</button>
      </div>
    </div>
  `,
  styles: [`
    .setup-overlay {
      position: fixed; inset: 0; z-index: 9999;
      display: flex; align-items: center; justify-content: center;
      background: rgba(10, 10, 14, 0.92); backdrop-filter: blur(6px);
    }
    .setup-card {
      width: min(460px, 92vw);
      background: var(--card-bg, #1b1b22);
      color: var(--text-color, #f2f2f5);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 16px;
      padding: 32px 32px 28px;
      box-shadow: 0 24px 60px rgba(0,0,0,0.5);
      text-align: center;
    }
    .setup-logo { font-size: 40px; line-height: 1; margin-bottom: 8px; }
    .setup-title { font-size: 20px; font-weight: 600; margin: 4px 0 6px; }
    .setup-sub { font-size: 13px; opacity: 0.7; margin: 0 0 20px; line-height: 1.5; }
    .setup-actions { display: flex; gap: 10px; justify-content: center; }
    .btn-primary {
      border: none; border-radius: 8px; padding: 9px 26px;
      font-size: 13px; font-weight: 500; cursor: pointer;
      background: #ff6a00; color: #fff;
    }

    .dl-dock {
      position: fixed; right: 18px; bottom: 18px; z-index: 9000;
      width: 300px;
      background: var(--card-bg, #1b1b22);
      color: var(--text-color, #f2f2f5);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px;
      box-shadow: 0 12px 36px rgba(0,0,0,0.55);
      overflow: hidden;
    }
    .dl-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 8px 8px 12px;
      background: rgba(255,255,255,0.05);
      border-bottom: 1px solid rgba(255,255,255,0.08);
      cursor: grab; user-select: none;
    }
    .dl-title { font-size: 12px; font-weight: 600; }
    .dl-close {
      font-size: 16px; line-height: 1; padding: 2px 6px;
      color: rgba(255,255,255,0.55); background: none; border: none; cursor: pointer;
    }
    .dl-close:hover { color: #fff; }
    .dl-items { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 12px; text-align: left; }
    .item-row { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 5px; }
    .item-name { font-size: 12px; font-weight: 500; }
    .item-status { font-size: 11px; opacity: 0.65; }
    .bar { height: 6px; border-radius: 4px; background: rgba(255,255,255,0.1); overflow: hidden; }
    .bar-fill {
      height: 100%; width: 0%;
      background: linear-gradient(90deg, #ff8a3d, #ff6a00);
      border-radius: 4px; transition: width 0.25s ease;
    }
    .bar-fill.done { background: linear-gradient(90deg, #36d07a, #27ae60); }
    .dl-error { padding: 12px; text-align: center; }
    .dl-error p { color: #ff7b7b; font-size: 12px; margin: 0 0 10px; }
  `],
})
export class SetupComponent implements OnInit, OnDestroy {
  @Output() complete = new EventEmitter<void>();

  state: 'checking' | 'approval' | 'installing' | 'idle' = 'checking';
  error: string | null = null;
  items: SetupItem[] = [];
  hasModel = false;
  totalLabel = '';

  // Dock drag state (translate offsets from the bottom-right anchor).
  dockX = 0;
  dockY = 0;
  dockDismissed = false;
  private dragBase: { x: number; y: number; dx: number; dy: number } | null = null;

  constructor(private electron: ElectronService) {}

  ngOnInit(): void {
    // Outside Electron (e.g. web preview) there are no assets to install.
    if (!this.electron.isElectron()) {
      this.state = 'idle';
      this.complete.emit();
      return;
    }
    this.electron.onAssetProgress((p) => this.onProgress(p));
    void this.check();
  }

  ngOnDestroy(): void {
    this.electron.removeAssetProgressListener();
    window.removeEventListener('mousemove', this.onDockDragMove);
    window.removeEventListener('mouseup', this.onDockDragEnd);
  }

  /** List required components; nothing missing releases the app instantly. */
  private async check(): Promise<void> {
    try {
      const res = await this.electron.listAssets();
      const required = (res.components || []).filter((c: any) => c.required);
      // Only surface components we can actually install now (a published artifact
      // exists). Unpublished required components are skipped — the app falls back.
      const missing = required.filter(
        (c: any) => c.state !== 'installed' && c.installable !== false
      );
      if (missing.length === 0) {
        this.state = 'idle';
        this.complete.emit();
        return;
      }
      this.items = missing.map((c: any) => ({
        id: c.id, name: c.name, description: c.description,
        pct: 0, phase: 'resolve', message: 'Waiting…', done: false,
      }));
      this.hasModel = missing.some((c: any) => c.id === 'whisper-medium');
      const bytes = missing.reduce((sum: number, c: any) => sum + (c.sizeBytes || 0), 0);
      this.totalLabel = bytes > 0 ? `${(bytes / 1e9).toFixed(1)} GB` : 'one-time download';
      this.state = 'approval';
    } catch {
      // Can't even list assets — release the app; features fail loudly on their own.
      this.state = 'idle';
      this.complete.emit();
    }
  }

  /** OK: release the app immediately and install in the background dock. */
  approve(): void {
    this.state = 'installing';
    this.complete.emit();
    void this.install();
  }

  private async install(): Promise<void> {
    this.error = null;
    try {
      const r = await this.electron.ensureRequiredAssets();
      const ok = r && (r.ok || (Array.isArray(r.failed) && r.failed.length === 0));
      if (ok) {
        this.items.forEach((it) => { it.done = true; it.pct = 100; });
        // Leave the completed bars visible for a beat, then fold the dock away.
        setTimeout(() => { this.state = 'idle'; }, 1500);
      } else {
        const failed = (r?.failed || []).join(', ');
        this.error = failed
          ? `Couldn't install: ${failed}. Check your connection and retry.`
          : (r?.error || 'Install failed. Check your connection and retry.');
        this.dockDismissed = false;   // an error re-surfaces even a dismissed dock
      }
    } catch (err: any) {
      this.error = err?.message || 'Install failed unexpectedly.';
      this.dockDismissed = false;
    }
  }

  retry(): void {
    void this.install();
  }

  private onProgress(p: any): void {
    const it = this.items.find((i) => i.id === p.id);
    if (!it) return;
    it.phase = p.phase;
    if (typeof p.pct === 'number') it.pct = p.pct;
    it.message = p.message || this.phaseLabel(p.phase);
    if (p.phase === 'done') { it.done = true; it.pct = 100; }
  }

  phaseLabel(phase: string): string {
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

  // ── Dock dragging ────────────────────────────────────────────────────────────
  onDockDragStart(ev: MouseEvent): void {
    if ((ev.target as HTMLElement)?.tagName === 'BUTTON') return;
    ev.preventDefault();
    this.dragBase = { x: ev.clientX, y: ev.clientY, dx: this.dockX, dy: this.dockY };
    window.addEventListener('mousemove', this.onDockDragMove);
    window.addEventListener('mouseup', this.onDockDragEnd);
  }
  private onDockDragMove = (ev: MouseEvent): void => {
    if (!this.dragBase) return;
    this.dockX = this.dragBase.dx + (ev.clientX - this.dragBase.x);
    this.dockY = this.dragBase.dy + (ev.clientY - this.dragBase.y);
  };
  private onDockDragEnd = (): void => {
    this.dragBase = null;
    window.removeEventListener('mousemove', this.onDockDragMove);
    window.removeEventListener('mouseup', this.onDockDragEnd);
  };
}
