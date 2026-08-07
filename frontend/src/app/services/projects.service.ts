// src/app/services/projects.service.ts
import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { ElectronService, ProjectScanResult, ProjectsRegistry } from './electron.service';

/**
 * One row of the projects list: what the registry persists (`path`/`name`/`lastOpened`)
 * plus the live scan of that folder, which is recomputed every load and never stored.
 * `scan` is null only in the window between publishing and a rescan resolving.
 */
export interface ProjectEntry {
  path: string;
  name: string;
  lastOpened: string;   // ISO date
  scan: ProjectScanResult | null;
}

/**
 * The projects registry — the app's list of project FOLDERS, replacing the editor/launcher's
 * `editor.recentSessions` localStorage blob (which is migrated in once and then left alone).
 *
 * Doctrine: a registry that will not parse is an ERROR the user sees, and it puts this service
 * into a read-only mode where no write can ever land — a corrupt list is repaired or deleted by
 * hand, never silently overwritten with an empty one. A folder that cannot be recognized is
 * reported with the scanner's verbatim reason instead of being dropped.
 */
@Injectable({
  providedIn: 'root'
})
export class ProjectsService {
  /** Set once the legacy recents have been folded in; the old key itself is left untouched. */
  private readonly MIGRATED_KEY = 'editor.projectsMigrated.v1';
  private readonly RECENTS_KEY = 'editor.recentSessions';

  private readonly projectsSubject = new BehaviorSubject<ProjectEntry[]>([]);
  private readonly errorSubject = new BehaviorSubject<string | null>(null);

  /** The list, sorted most-recently-opened first. */
  readonly projects$: Observable<ProjectEntry[]> = this.projectsSubject.asObservable();
  /** Non-null when the on-disk registry could not be read; the UI shows it and disables adds. */
  readonly error$: Observable<string | null> = this.errorSubject.asObservable();

  /** Latched by a failed registry read. Every write path refuses while it is set. */
  private readOnly = false;
  private entries: ProjectEntry[] = [];

  constructor(private electron: ElectronService) {}

  get snapshot(): ProjectEntry[] { return this.projectsSubject.value; }
  get registryError(): string | null { return this.errorSubject.value; }

  /**
   * Read the registry, scan every entry in parallel, publish. A read failure surfaces on
   * `error$`, publishes an empty list and latches read-only so the corrupt file survives.
   */
  async load(): Promise<void> {
    let registry: ProjectsRegistry;
    try {
      registry = await this.electron.readProjectsRegistry();
    } catch (err: any) {
      this.readOnly = true;
      this.entries = [];
      this.errorSubject.next(err?.message || String(err));
      this.publish();
      return;
    }
    this.readOnly = false;
    this.errorSubject.next(null);

    const rows = Array.isArray(registry?.projects) ? registry.projects : [];
    this.entries = await Promise.all(rows.map(async (row) => ({
      path: row.path,
      name: row.name,
      lastOpened: row.lastOpened,
      scan: await this.scanOrReport(row.path)
    })));
    this.publish();

    await this.migrateLegacyRecents();
  }

  /**
   * Add a folder. Scans FIRST: an unrecognized folder throws with the scanner's reason and is
   * never written to the registry. Adding a folder that is already listed (same resolved real
   * path, or failing that the same literal path) is a no-op returning the existing entry.
   *
   * `lastOpened` is only passed by the legacy-recents migration, which preserves the original
   * timestamps rather than stamping the whole imported list with "now".
   */
  async addProject(folderPath: string, lastOpened?: string): Promise<ProjectEntry> {
    const scan = await this.electron.scanProjectFolder(folderPath);
    if (scan.state === 'unrecognized') {
      throw new Error(scan.error || `Not a project folder: ${folderPath}`);
    }
    const existing = this.findExisting(folderPath, scan);
    if (existing) return existing;

    const entry: ProjectEntry = {
      path: folderPath,
      name: scan.session || this.basename(folderPath),
      lastOpened: lastOpened || new Date().toISOString(),
      scan
    };
    await this.commit([...this.entries, entry]);
    return entry;
  }

  /** Open the directory chooser and add what comes back. Resolves null when cancelled. */
  async addFromDialog(): Promise<ProjectEntry | null> {
    const picked = await this.electron.selectDirectory({ title: 'Choose a project folder' });
    if (picked.canceled || !picked.filePaths?.length) return null;
    return this.addProject(picked.filePaths[0]);
  }

  /**
   * Stamp an entry as just-opened and re-sort. `path` may be either the project folder or the
   * session's compounds zip, because the editor opens sessions by zip path. A path matching
   * nothing in the registry is not an error — plenty of sessions are opened outside the list.
   */
  async markOpened(path: string): Promise<void> {
    const idx = this.entries.findIndex(e => e.path === path || e.scan?.zipPath === path);
    if (idx < 0) return;
    const next = this.entries.slice();
    next[idx] = { ...next[idx], lastOpened: new Date().toISOString() };
    await this.commit(next);
  }

  /** Drop an entry from the LIST. Never touches anything on disk inside the project folder. */
  async removeProject(path: string): Promise<void> {
    const next = this.entries.filter(e => e.path !== path);
    if (next.length === this.entries.length) return;
    await this.commit(next);
  }

  /** Re-scan one entry (e.g. after a volume mounts, or a job finishes). No registry write. */
  async rescan(path: string): Promise<void> {
    const idx = this.entries.findIndex(e => e.path === path);
    if (idx < 0) return;
    const scan = await this.scanOrReport(this.entries[idx].path);
    this.entries = this.entries.slice();
    this.entries[idx] = { ...this.entries[idx], scan };
    this.publish();
  }

  /** Re-scan everything in parallel. No registry write. */
  async rescanAll(): Promise<void> {
    const scans = await Promise.all(this.entries.map(e => this.scanOrReport(e.path)));
    this.entries = this.entries.map((e, i) => ({ ...e, scan: scans[i] }));
    this.publish();
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  /**
   * Scan for the LIST. A scan that throws outright (IPC gone, permission denied) becomes a
   * visible 'unrecognized' row carrying the verbatim reason rather than taking the whole list
   * down with it — loud, per-row, and still refusing to pretend the folder is fine. addProject
   * deliberately does NOT use this: there a throw must reach the user's inline error.
   */
  private async scanOrReport(folderPath: string): Promise<ProjectScanResult> {
    try {
      return await this.electron.scanProjectFolder(folderPath);
    } catch (err: any) {
      return {
        folder: folderPath,
        realPath: null,
        exists: false,
        state: 'unrecognized',
        error: `Could not scan this folder: ${err?.message || String(err)}`
      };
    }
  }

  /** Identity is the resolved real path when both sides have one; the literal path otherwise. */
  private findExisting(folderPath: string, scan: ProjectScanResult): ProjectEntry | null {
    for (const e of this.entries) {
      if (scan.realPath && e.scan?.realPath && e.scan.realPath === scan.realPath) return e;
      if (e.path === folderPath) return e;
    }
    return null;
  }

  /** Persist `next` and only then adopt it — a failed write leaves the UI showing the truth. */
  private async commit(next: ProjectEntry[]): Promise<void> {
    if (this.readOnly) {
      throw new Error(
        `Projects list is read-only until the registry is fixed: ${this.errorSubject.value || 'it could not be read'}`
      );
    }
    const registry: ProjectsRegistry = {
      version: 1,
      projects: next.map(e => ({ path: e.path, name: e.name, lastOpened: e.lastOpened }))
    };
    await this.electron.writeProjectsRegistry(registry);
    this.entries = next;
    this.publish();
  }

  private publish(): void {
    const sorted = this.entries
      .slice()
      .sort((a, b) => (b.lastOpened || '').localeCompare(a.lastOpened || ''));
    this.projectsSubject.next(sorted);
  }

  private basename(p: string): string {
    return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
  }

  private dirname(p: string): string {
    const parts = p.split(/[\\/]/);
    parts.pop();
    return parts.join('/');
  }

  /**
   * One-time import of the editor/launcher's `editor.recentSessions` blob: each recent's zip
   * lives INSIDE its project folder, so dirname(zipPath) is the folder to add, and the recent's
   * own lastOpened is carried over so the imported list keeps its order. A recent whose folder
   * no longer looks like a project is skipped with a console.warn naming folder AND reason —
   * never silently. The old localStorage key is left in place; the launcher still reads it.
   */
  private async migrateLegacyRecents(): Promise<void> {
    if (this.readOnly) return;
    if (localStorage.getItem(this.MIGRATED_KEY)) return;

    let recents: Array<{ zipPath: string; lastOpened?: string }> = [];
    try {
      const raw = localStorage.getItem(this.RECENTS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        recents = parsed.filter((r: any) => r && typeof r.zipPath === 'string');
      }
    } catch (err: any) {
      console.warn(`[projects] legacy recents unreadable, nothing migrated: ${err?.message || String(err)}`);
      recents = [];
    }

    for (const r of recents) {
      const folder = this.dirname(r.zipPath);
      if (!folder) {
        console.warn(`[projects] migration skipped '${r.zipPath}': no containing folder in the path`);
        continue;
      }
      try {
        await this.addProject(folder, r.lastOpened);
      } catch (err: any) {
        console.warn(`[projects] migration skipped '${folder}': ${err?.message || String(err)}`);
      }
    }
    localStorage.setItem(this.MIGRATED_KEY, '1');
  }
}
