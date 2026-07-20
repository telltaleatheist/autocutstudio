import { Component, OnInit } from '@angular/core';
import { ElectronService } from '../../services/electron.service';

/**
 * Editor launcher (main window, creamsicle theme).
 *
 * Picks a processed session by its `<name>_compounds.zip` and opens the timeline
 * editor in its own chromeless window. Keeps a "Recent sessions" list in localStorage,
 * pruned on load against the filesystem so stale entries never linger.
 *
 * Doctrine: no silent fallbacks. openEditor errors are surfaced verbatim; a session
 * whose zip has vanished is removed from Recents rather than shown as clickable.
 */

interface RecentSession {
  zipPath: string;
  name: string;       // filename minus _compounds.zip
  lastOpened: string; // ISO date
}

const RECENTS_KEY = 'editor.recentSessions';
const COMPOUNDS_SUFFIX = '_compounds.zip';

@Component({
  selector: 'app-editor-launcher',
  standalone: false,
  templateUrl: './editor-launcher.component.html',
  styleUrl: './editor-launcher.component.scss'
})
export class EditorLauncherComponent implements OnInit {
  recents: RecentSession[] = [];
  errorMessage = '';
  opening = false;

  constructor(private electron: ElectronService) {}

  async ngOnInit(): Promise<void> {
    await this.loadAndPruneRecents();
  }

  // ── Recents persistence ─────────────────────────────────────────────────────
  private readRecents(): RecentSession[] {
    try {
      const raw = localStorage.getItem(RECENTS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((r: any) => r && typeof r.zipPath === 'string');
    } catch {
      // A corrupt Recents blob is not a session error — start clean rather than crash.
      return [];
    }
  }

  private writeRecents(list: RecentSession[]): void {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(list));
  }

  /** Load Recents and drop any whose zip no longer exists on disk. */
  private async loadAndPruneRecents(): Promise<void> {
    const stored = this.readRecents();
    const kept: RecentSession[] = [];
    for (const r of stored) {
      try {
        const res = await this.electron.checkFileExists(r.zipPath);
        if (res?.exists) kept.push(r);
      } catch {
        // If we cannot verify existence (not in Electron / IPC hiccup), keep the entry
        // rather than silently deleting the user's history.
        kept.push(r);
      }
    }
    kept.sort((a, b) => (b.lastOpened || '').localeCompare(a.lastOpened || ''));
    this.recents = kept;
    this.writeRecents(kept);
  }

  private deriveName(zipPath: string): string {
    const base = zipPath.split(/[\\/]/).pop() || zipPath;
    if (base.endsWith(COMPOUNDS_SUFFIX)) {
      return base.slice(0, -COMPOUNDS_SUFFIX.length);
    }
    return base.replace(/\.zip$/i, '');
  }

  private recordRecent(zipPath: string): void {
    const name = this.deriveName(zipPath);
    const entry: RecentSession = { zipPath, name, lastOpened: new Date().toISOString() };
    const rest = this.recents.filter(r => r.zipPath !== zipPath);
    this.recents = [entry, ...rest];
    this.writeRecents(this.recents);
  }

  // ── Actions ─────────────────────────────────────────────────────────────────
  async pickSession(): Promise<void> {
    this.errorMessage = '';
    let picked: { canceled: boolean; filePaths: string[] };
    try {
      picked = await this.electron.selectFile({
        title: 'Choose a session’s _compounds.zip',
        filters: [{ name: 'Compound Session', extensions: ['zip'] }]
      });
    } catch (err: any) {
      this.errorMessage = err?.message || String(err);
      return;
    }
    if (picked.canceled || !picked.filePaths?.length) return;
    await this.openSession(picked.filePaths[0]);
  }

  async openRecent(r: RecentSession): Promise<void> {
    await this.openSession(r.zipPath);
  }

  async removeRecent(r: RecentSession, ev: Event): Promise<void> {
    ev.stopPropagation();
    this.recents = this.recents.filter(x => x.zipPath !== r.zipPath);
    this.writeRecents(this.recents);
  }

  private async openSession(zipPath: string): Promise<void> {
    this.errorMessage = '';
    this.opening = true;
    try {
      const res = await this.electron.openEditor({ zipPath });
      if (!res?.success) {
        // Surface the bridge's own message verbatim; do not invent one.
        this.errorMessage = res?.error || 'The editor could not be opened.';
        this.opening = false;
        return;
      }
      // Only remember sessions we actually opened successfully.
      this.recordRecent(zipPath);
    } catch (err: any) {
      this.errorMessage = err?.message || String(err);
    } finally {
      this.opening = false;
    }
  }
}
