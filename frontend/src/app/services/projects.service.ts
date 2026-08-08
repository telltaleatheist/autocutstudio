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
  private readonly prunedSubject = new BehaviorSubject<string | null>(null);

  /**
   * The list. Sorted most-recently-opened first ONCE per load(); the order then stays
   * stable for the window's life — opening a project updates its timestamp (persisted,
   * so the next launch sorts it up) without reshuffling the rows mid-session.
   */
  readonly projects$: Observable<ProjectEntry[]> = this.projectsSubject.asObservable();
  /** Non-null when the on-disk registry could not be read; the UI shows it and disables adds. */
  readonly error$: Observable<string | null> = this.errorSubject.asObservable();
  /** Set when entries were dropped because their folders are gone — shown, then dismissed. */
  readonly pruned$: Observable<string | null> = this.prunedSubject.asObservable();

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
    this.sortByRecency();
    this.publish();

    await this.migrateLegacyRecents();
    // Migration appends in iteration order; fold the imported timestamps into the
    // recency order once, so the first post-migration render matches the next launch.
    this.sortByRecency();
    this.publish();

    await this.pruneMissing();
  }

  /**
   * Drop entries whose folder is gone for good. A project is a LINK to a folder: once that
   * folder has been moved or deleted the link is dead, and the row would only ever be a
   * dead end. Dropping it costs nothing — dragging the folder back in re-adds it.
   *
   * Only state 'missing' is dropped, never 'unreachable': the scanner separates "the volume
   * is here and the folder is not" from "the volume itself is absent". Without that split,
   * launching with an external drive unplugged would silently erase every project on it.
   *
   * What was removed is REPORTED (`pruned$`), not done quietly — the list changing itself
   * behind the user's back is exactly the kind of thing that should be said out loud.
   */
  private async pruneMissing(): Promise<void> {
    if (this.readOnly) return;   // never write while the on-disk registry is suspect
    const dead = this.entries.filter(e => e.scan?.state === 'missing');
    if (dead.length === 0) return;

    const keep = this.entries.filter(e => e.scan?.state !== 'missing');
    try {
      await this.commit(keep);
    } catch (err: any) {
      // The registry could not be rewritten; the rows stay. Say so rather than leaving a
      // list that disagrees with the file it came from.
      this.prunedSubject.next(
        `Could not update the projects list: ${err?.message || String(err)}`);
      return;
    }
    const names = dead.map(e => e.name).join(', ');
    this.prunedSubject.next(dead.length === 1
      ? `Removed “${names}” — its folder is no longer there. Drag it back in if it returns.`
      : `Removed ${dead.length} projects whose folders are no longer there (${names}).`);
  }

  /** Dismiss the "removed N projects" notice. */
  clearPrunedNotice(): void {
    this.prunedSubject.next(null);
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
    // Newest first, matching where the load()-time recency sort would put it — without
    // reshuffling the rows already on screen.
    await this.commit([entry, ...this.entries]);
    return entry;
  }

  /** Open the directory chooser and add what comes back. Resolves null when cancelled. */
  async addFromDialog(): Promise<ProjectEntry | null> {
    const picked = await this.electron.selectDirectory({ title: 'Choose a project folder' });
    if (picked.canceled || !picked.filePaths?.length) return null;
    return this.addProject(picked.filePaths[0]);
  }

  /**
   * Stamp an entry as just-opened — WITHOUT reordering the visible list (the row must not
   * jump under the cursor; recency ordering is applied once per load). `path` may be either
   * the project folder or the session's compounds zip, because the editor opens sessions by
   * zip path. A path matching nothing in the registry is not an error — plenty of sessions
   * are opened outside the list.
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

  /** Re-scan everything in parallel, then drop anything whose folder has since gone. */
  async rescanAll(): Promise<void> {
    const scans = await Promise.all(this.entries.map(e => this.scanOrReport(e.path)));
    this.entries = this.entries.map((e, i) => ({ ...e, scan: scans[i] }));
    this.publish();
    await this.pruneMissing();
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

  /** Emit the list AS ORDERED — sorting is load()'s job, exactly once per read. */
  private publish(): void {
    this.projectsSubject.next(this.entries.slice());
  }

  private sortByRecency(): void {
    this.entries = this.entries
      .slice()
      .sort((a, b) => (b.lastOpened || '').localeCompare(a.lastOpened || ''));
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
