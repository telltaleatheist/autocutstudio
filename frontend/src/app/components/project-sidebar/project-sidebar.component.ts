import { Component, EventEmitter, Input, OnDestroy, OnInit, Output, ChangeDetectorRef } from '@angular/core';
import { Subscription } from 'rxjs';
import { ElectronService } from '../../services/electron.service';
import { ProjectEntry, ProjectsService } from '../../services/projects.service';

/**
 * The editor's far-left FCPX-libraries column, rendered INSIDE the editor's existing
 * `.project-pane` (the pane container, its splitter and the width binding stay in the editor).
 *
 * Deliberately dumb: it lists what ProjectsService publishes and emits what the user meant.
 * The editor decides what opening or processing a project actually does — this component never
 * calls bootstrap, and never starts a job. The one thing it owns is adding/removing entries,
 * because those are list operations, not session operations.
 *
 * Failures are shown in the pane, never in an alert() and never swallowed: a corrupt registry
 * banners across the top and disables the + button, and a rejected add prints inline under the
 * header until the next successful action clears it.
 */
@Component({
  selector: 'app-project-sidebar',
  templateUrl: './project-sidebar.component.html',
  styleUrls: ['./project-sidebar.component.scss'],
  standalone: false
})
export class ProjectSidebarComponent implements OnInit, OnDestroy {
  /**
   * The project a job is currently running on, by `entry.path`. Renders a spinner (and the
   * percent, when given) on that row. Nothing here drives it yet — a later agent feeds it from
   * the processing job.
   */
  @Input() busyPath: string | null = null;
  /** Optional 0-100 progress for `busyPath`; null shows an indeterminate spinner. */
  @Input() busyPercent: number | null = null;
  /**
   * The session loaded in this window (a compounds zip path). The entry whose scan points at
   * that zip gets the active highlight — same behaviour the old recents list had.
   */
  @Input() activeZipPath: string | null = null;

  /** A processed/edited project the user wants loaded. The editor bootstraps `scan.zipPath`. */
  @Output() openRequested = new EventEmitter<ProjectEntry>();
  /** A raw project the user wants processed. The editor owns the processing UI. */
  @Output() processRequested = new EventEmitter<ProjectEntry>();

  projects: ProjectEntry[] = [];
  /** Registry could not be read: banner text, and adds are refused while it is set. */
  registryError: string | null = null;
  /** Last failed add/remove, shown under the header. Cleared by the next successful action. */
  inlineError: string | null = null;
  dragOver = false;

  private subs: Subscription[] = [];

  constructor(
    private projectsService: ProjectsService,
    private electron: ElectronService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.subs.push(this.projectsService.projects$.subscribe(list => {
      this.projects = list;
      this.cdr.markForCheck();
    }));
    this.subs.push(this.projectsService.error$.subscribe(err => {
      this.registryError = err;
      this.cdr.markForCheck();
    }));
  }

  ngOnDestroy(): void {
    this.subs.forEach(s => s.unsubscribe());
    this.subs = [];
  }

  trackByPath = (_: number, e: ProjectEntry) => e.path;

  /** Let the host put a message on the pane's inline error line (it owns no other surface). */
  showError(message: string): void {
    this.inlineError = message;
    this.cdr.markForCheck();
  }

  // ── Row state ───────────────────────────────────────────────────────────────

  /** 'missing' when a folder has never been scanned — nothing about it is known yet. */
  state(e: ProjectEntry): string {
    return e.scan?.state || 'missing';
  }

  /** Only a project we can act on is clickable; missing/unrecognized rows are dead. */
  isActionable(e: ProjectEntry): boolean {
    const s = this.state(e);
    return s === 'raw' || s === 'processed' || s === 'edited';
  }

  isActive(e: ProjectEntry): boolean {
    return !!this.activeZipPath && e.scan?.zipPath === this.activeZipPath;
  }

  isBusy(e: ProjectEntry): boolean {
    return !!this.busyPath && e.path === this.busyPath;
  }

  /** Hover text: the verbatim reason for a dead row, otherwise the folder it points at. */
  rowTitle(e: ProjectEntry): string {
    const s = this.state(e);
    if (s === 'missing') return `${e.path}\nNot available — the folder or its volume is not mounted.`;
    if (s === 'unrecognized') return `${e.path}\n${e.scan?.error || 'No master video found in this folder.'}`;
    if (s === 'raw') return `${e.path}\nNot processed yet — click to process.`;
    return e.scan?.zipPath || e.path;
  }

  // ── Actions ─────────────────────────────────────────────────────────────────

  onRowClick(e: ProjectEntry): void {
    if (!this.isActionable(e)) return;
    this.inlineError = null;
    if (this.state(e) === 'raw') {
      this.processRequested.emit(e);
      return;
    }
    this.openRequested.emit(e);
  }

  async onAdd(): Promise<void> {
    if (this.registryError) return;
    try {
      const added = await this.projectsService.addFromDialog();
      if (added) this.inlineError = null;
    } catch (err: any) {
      this.inlineError = err?.message || String(err);
    }
    this.cdr.markForCheck();
  }

  async onRemove(ev: Event, e: ProjectEntry): Promise<void> {
    ev.stopPropagation();
    try {
      await this.projectsService.removeProject(e.path);
      this.inlineError = null;
    } catch (err: any) {
      this.inlineError = err?.message || String(err);
    }
    this.cdr.markForCheck();
  }

  // ── Drag & drop a folder onto the pane ──────────────────────────────────────

  onDragOver(ev: DragEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.dragOver = true;
  }

  onDragLeave(ev: DragEvent): void {
    ev.preventDefault();
    this.dragOver = false;
  }

  /**
   * Electron 32 removed File.path, so the absolute path has to come from the preload's
   * webUtils (getPathForFile). An empty string means the drop was not a filesystem item at all
   * (a browser drag, a text selection) — said plainly rather than reported as a bad project.
   * Whether the path is a directory is settled by the scan, not guessed here.
   */
  async onDrop(ev: DragEvent): Promise<void> {
    ev.preventDefault();
    ev.stopPropagation();
    this.dragOver = false;
    if (this.registryError) return;

    const files = Array.from(ev.dataTransfer?.files || []);
    if (files.length === 0) {
      this.inlineError = 'Nothing droppable there — drop a project folder.';
      this.cdr.markForCheck();
      return;
    }
    for (const file of files) {
      const path = this.electron.getPathForFile(file);
      if (!path) {
        this.inlineError = `“${file.name}” is not a filesystem folder.`;
        continue;
      }
      try {
        await this.projectsService.addProject(path);
        this.inlineError = null;
      } catch (err: any) {
        this.inlineError = err?.message || String(err);
      }
    }
    this.cdr.markForCheck();
  }
}
