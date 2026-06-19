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
 * First-run setup overlay. On launch, if any required downloadable asset
 * (ffmpeg/ffprobe, the Python runtime) is missing, this blocks the app with a
 * progress screen while they download into the shared OwenMorgan location, then
 * emits `complete`. If everything is already present, it completes immediately.
 */
@Component({
  selector: 'app-setup',
  standalone: false,
  template: `
    <div class="setup-overlay">
      <div class="setup-card">
        <div class="setup-logo">🎬</div>
        <h1 class="setup-title">Setting up AutoCutStudio</h1>

        <ng-container *ngIf="checking">
          <p class="setup-sub">Checking required components…</p>
          <div class="spinner"></div>
        </ng-container>

        <ng-container *ngIf="!checking && !error">
          <p class="setup-sub">Downloading required components. This runs once and is shared across apps.</p>
          <div class="setup-items">
            <div class="setup-item" *ngFor="let it of items">
              <div class="item-row">
                <span class="item-name">{{ it.name }}</span>
                <span class="item-status">{{ it.done ? 'Ready' : (it.message || phaseLabel(it.phase)) }}</span>
              </div>
              <div class="bar"><div class="bar-fill" [class.done]="it.done" [style.width.%]="it.done ? 100 : it.pct"></div></div>
            </div>
          </div>
        </ng-container>

        <ng-container *ngIf="error">
          <p class="setup-error">{{ error }}</p>
          <div class="setup-actions">
            <button class="btn-primary" (click)="retry()">Retry</button>
            <button class="btn-secondary" (click)="skipAnyway()">Continue anyway</button>
          </div>
          <p class="setup-hint">“Continue anyway” falls back to bundled/system tools where possible.</p>
        </ng-container>
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
      width: min(520px, 92vw);
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
    .setup-sub { font-size: 13px; opacity: 0.7; margin: 0 0 20px; }
    .setup-items { display: flex; flex-direction: column; gap: 16px; text-align: left; }
    .item-row { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
    .item-name { font-size: 14px; font-weight: 500; }
    .item-status { font-size: 12px; opacity: 0.65; }
    .bar { height: 8px; border-radius: 6px; background: rgba(255,255,255,0.1); overflow: hidden; }
    .bar-fill {
      height: 100%; width: 0%;
      background: linear-gradient(90deg, #ff8a3d, #ff6a00);
      border-radius: 6px; transition: width 0.25s ease;
    }
    .bar-fill.done { background: linear-gradient(90deg, #36d07a, #27ae60); }
    .spinner {
      width: 28px; height: 28px; margin: 8px auto 0;
      border: 3px solid rgba(255,255,255,0.15); border-top-color: #ff6a00;
      border-radius: 50%; animation: spin 0.9s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .setup-error { color: #ff7b7b; font-size: 13px; margin: 4px 0 18px; }
    .setup-actions { display: flex; gap: 10px; justify-content: center; }
    .setup-hint { font-size: 11px; opacity: 0.5; margin: 14px 0 0; }
    .btn-primary, .btn-secondary {
      border: none; border-radius: 8px; padding: 9px 18px;
      font-size: 13px; font-weight: 500; cursor: pointer;
    }
    .btn-primary { background: #ff6a00; color: #fff; }
    .btn-secondary { background: rgba(255,255,255,0.1); color: var(--text-color, #f2f2f5); }
  `],
})
export class SetupComponent implements OnInit, OnDestroy {
  @Output() complete = new EventEmitter<void>();

  checking = true;
  error: string | null = null;
  items: SetupItem[] = [];

  constructor(private electron: ElectronService) {}

  ngOnInit(): void {
    // Outside Electron (e.g. web preview) there are no assets to install.
    if (!this.electron.isElectron()) {
      this.complete.emit();
      return;
    }
    this.electron.onAssetProgress((p) => this.onProgress(p));
    void this.start();
  }

  ngOnDestroy(): void {
    this.electron.removeAssetProgressListener();
  }

  private async start(): Promise<void> {
    this.checking = true;
    this.error = null;
    try {
      const res = await this.electron.listAssets();
      const required = (res.components || []).filter((c: any) => c.required);
      // Only surface components we can actually install now (a published artifact
      // exists). Unpublished required components are skipped — the app falls back.
      const missing = required.filter(
        (c: any) => c.state !== 'installed' && c.installable !== false
      );

      if (missing.length === 0) {
        this.complete.emit();
        return;
      }

      this.items = missing.map((c: any) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        pct: 0,
        phase: 'resolve',
        message: 'Waiting…',
        done: false,
      }));
      this.checking = false;

      const r = await this.electron.ensureRequiredAssets();
      const ok = r && (r.ok || (Array.isArray(r.failed) && r.failed.length === 0));
      if (ok) {
        this.items.forEach((it) => {
          it.done = true;
          it.pct = 100;
        });
        // Brief beat so completed bars are visible before the app appears.
        setTimeout(() => this.complete.emit(), 350);
      } else {
        const failed = (r?.failed || []).join(', ');
        this.error = failed
          ? `Couldn't install: ${failed}. Check your connection and retry.`
          : (r?.error || 'Setup failed. Check your connection and retry.');
      }
    } catch (err: any) {
      this.error = err?.message || 'Setup failed unexpectedly.';
    }
  }

  private onProgress(p: any): void {
    const it = this.items.find((i) => i.id === p.id);
    if (!it) return;
    it.phase = p.phase;
    if (typeof p.pct === 'number') it.pct = p.pct;
    it.message = p.message || this.phaseLabel(p.phase);
    if (p.phase === 'done') {
      it.done = true;
      it.pct = 100;
    }
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

  retry(): void {
    void this.start();
  }

  skipAnyway(): void {
    this.complete.emit();
  }
}
