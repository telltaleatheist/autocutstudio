import { Component, OnInit, signal } from '@angular/core';
import { ElectronService } from '../../services/electron.service';

/**
 * Reports tab — every metadata report the Metadata page has ever produced, kept so a video
 * can be re-packaged weeks later without re-running the AI.
 *
 * Ported from ContentStudio's metadata-reports. The on-disk layout it reads is that app's,
 * unchanged, because the generator that writes it is the same code ported alongside this:
 * one JSON per JOB under `<outputDirectory>/.contentstudio/metadata/`, each holding an
 * `items` array with one entry per input. A row here is one ITEM, not one job — a
 * compilation job of eight videos is eight reports the user can open independently.
 *
 * Doctrine: no fallbacks when reading an item. A report whose itemIndex is missing or out of
 * bounds throws with the reason rather than quietly showing item 0 — showing the wrong
 * video's titles is far worse than showing an error.
 */

interface MetadataReport {
  /** Unique per ROW (`<jobId>-item-<n>`), which is what the list tracks by. */
  name: string;
  /** Path to the job's JSON — SHARED by every row from the same job. */
  path: string;
  date: Date;
  size: number;
  promptSet?: string;
  displayTitle?: string;
  txtFolder?: string;
  jobId?: string;
  /** Which entry of the job's `items` array this row is. */
  itemIndex?: number;
  txtFilePath?: string;
  selected?: boolean;
}

interface ParsedMetadata {
  titles: string[];
  thumbnail_text: string[];
  description: string;
  tags: string | string[]; // Comma-separated string OR array, depending on the model
  hashtags: string;
  pinned_comment?: string[];
  clip_suggestions?: string[];
  chapters?: Array<{ timestamp: string; title: string; sequence: number }>;
  _title?: string;
  _prompt_set?: string;
}

interface Notice {
  id: number;
  kind: 'error' | 'warning' | 'success';
  title: string;
  text: string;
}

@Component({
  selector: 'app-metadata-reports',
  standalone: false,
  templateUrl: './metadata-reports.component.html',
  styleUrl: './metadata-reports.component.scss',
})
export class MetadataReportsComponent implements OnInit {
  reports = signal<MetadataReport[]>([]);
  selectedReport = signal<MetadataReport | null>(null);
  metadata = signal<ParsedMetadata | null>(null);
  isLoading = signal(false);
  reportsDirectory = signal('');

  notices = signal<Notice[]>([]);
  private noticeSeq = 0;

  copiedItem = signal<string | null>(null);
  private copiedTimeout: any = null;

  constructor(private electron: ElectronService) {}

  async ngOnInit(): Promise<void> {
    if (!this.electron.isElectron()) {
      this.notify('error', 'Desktop app required', 'Reports are read from disk — this needs the desktop app.');
      return;
    }
    await this.loadReports();
  }

  // ── Notices ────────────────────────────────────────────────────────────────

  private notify(kind: Notice['kind'], title: string, text: string): void {
    const notice: Notice = { id: ++this.noticeSeq, kind, title, text };
    this.notices.update((n) => [...n, notice]);
    if (kind === 'success') setTimeout(() => this.dismissNotice(notice.id), 5000);
  }

  dismissNotice(id: number): void {
    this.notices.update((n) => n.filter((x) => x.id !== id));
  }

  // ── Loading ────────────────────────────────────────────────────────────────

  async loadReports(): Promise<void> {
    try {
      this.isLoading.set(true);

      const settings = await this.electron.getMetadataSettings();
      const baseDir = settings?.outputDirectory;

      if (!baseDir) {
        this.reports.set([]);
        this.reportsDirectory.set('');
        this.notify('warning', 'No output directory', 'No output directory configured — set one in Settings.');
        return;
      }

      // The generator's layout, unchanged from ContentStudio. Renaming this folder would
      // orphan every report the ported backend writes.
      const metadataJsonDir = `${baseDir}/.contentstudio/metadata`;
      this.reportsDirectory.set(metadataJsonDir);

      let result: any = null;
      try {
        result = await this.electron.readDirectory(metadataJsonDir);
      } catch {
        // A missing folder is the normal state before the first run, not an error.
      }

      if (!result?.success || !result.files) {
        this.reports.set([]);
        return;
      }

      const reports: MetadataReport[] = [];

      for (const file of result.files) {
        if (!file.name.endsWith('.json')) continue;

        try {
          const jsonPath = `${metadataJsonDir}/${file.name}`;
          const content = await this.electron.readFile(jsonPath);
          if (!content) continue;

          const jobData = JSON.parse(content);
          const txtFolder = jobData.txt_folder || '';
          const jobDate = new Date(jobData.created_at || file.mtime);
          const jobId = jobData.job_id || file.name.replace('.json', '');

          if (Array.isArray(jobData.items)) {
            // One ROW PER ITEM: a compilation of eight videos is eight openable reports.
            jobData.items.forEach((item: any, index: number) => {
              reports.push({
                name: `${jobId}-item-${index}`,
                path: jsonPath,
                date: jobDate,
                size: file.size || 0,
                promptSet: jobData.prompt_set,
                displayTitle: item._title || `Item ${index + 1}`,
                txtFolder,
                jobId,
                itemIndex: index,
                txtFilePath: jobData.txt_files?.[index] || '',
              });
            });
          } else {
            // A job written without an items array. Listed so it is at least visible, but
            // it has no itemIndex, so opening it will say so rather than guess.
            reports.push({
              name: jobId,
              path: jsonPath,
              date: jobDate,
              size: file.size || 0,
              promptSet: jobData.prompt_set,
              displayTitle: jobData.job_name,
              txtFolder,
              jobId,
            });
          }
        } catch (e) {
          this.notify('warning', 'Unreadable report', `Could not read ${file.name}: ${(e as Error).message}`);
        }
      }

      reports.sort((a, b) => b.date.getTime() - a.date.getTime());
      this.reports.set(reports);
    } catch (error: any) {
      this.notify('error', 'Load failed', `Failed to load metadata reports: ${error?.message || error}`);
    } finally {
      this.isLoading.set(false);
    }
  }

  async selectReport(report: MetadataReport): Promise<void> {
    try {
      this.isLoading.set(true);
      this.selectedReport.set(report);

      const content = await this.electron.readFile(report.path);
      if (!content) throw new Error('The report file is empty.');

      const jobData = JSON.parse(content);

      // Strict, deliberately. Falling back to item 0 here would show one video's titles
      // under another video's name, and nothing on screen would say so.
      if (report.itemIndex === undefined) {
        throw new Error('Report has no itemIndex — cannot tell which item to load.');
      }
      if (!Array.isArray(jobData.items)) {
        throw new Error('Job data has no items array — the file structure is not what the generator writes.');
      }
      if (jobData.items.length <= report.itemIndex) {
        throw new Error(`Item index ${report.itemIndex} is out of bounds (the job has ${jobData.items.length} items).`);
      }

      this.metadata.set(this.normalizeMetadataKeys(jobData.items[report.itemIndex]));
    } catch (error: any) {
      this.notify('error', 'Read failed', `Failed to read the report: ${error?.message || error}`);
      this.metadata.set(null);
    } finally {
      this.isLoading.set(false);
    }
  }

  async showInFolder(report: MetadataReport): Promise<void> {
    try {
      // Prefer this item's own TXT, then the job's TXT folder, then the JSON itself.
      await this.electron.showInFolder(report.txtFilePath || report.txtFolder || report.path);
    } catch (error: any) {
      this.notify('error', 'Show in folder', error?.message || String(error));
    }
  }

  async deleteReport(report: MetadataReport, event: Event): Promise<void> {
    event.stopPropagation();

    try {
      if (report.txtFilePath) {
        try {
          await this.electron.deleteDirectory(report.txtFilePath);
        } catch (e) {
          this.notify('warning', 'Delete', `Could not delete ${report.txtFilePath}: ${(e as Error).message}`);
        }
      }

      const jobReports = this.reports().filter((r) => r.jobId === report.jobId);

      if (jobReports.length === 1) {
        // Last item of the job — the JSON has nothing left to describe.
        await this.electron.deleteDirectory(report.path);
      } else {
        // Splice this item out of the shared JSON, leaving its siblings intact.
        const content = await this.electron.readFile(report.path);
        if (content) {
          const jobData = JSON.parse(content);
          if (jobData.items && report.itemIndex !== undefined) {
            jobData.items.splice(report.itemIndex, 1);
            if (jobData.txt_files?.[report.itemIndex]) jobData.txt_files.splice(report.itemIndex, 1);
            await this.electron.writeTextFile(report.path, JSON.stringify(jobData, null, 2));
          }
        }
      }

      // Renumber the sibling rows for this job so their itemIndex stays aligned with the
      // now-spliced items array — otherwise clicking a later sibling throws "out of bounds".
      // The TXT each sibling points at is unchanged by the splice, so txtFilePath stays.
      const deletedIndex = report.itemIndex;
      this.reports.update((reports) =>
        reports
          .filter((r) => r.name !== report.name)
          .map((r) => {
            if (
              r.jobId === report.jobId &&
              deletedIndex !== undefined &&
              r.itemIndex !== undefined &&
              r.itemIndex > deletedIndex
            ) {
              const newIndex = r.itemIndex - 1;
              return { ...r, itemIndex: newIndex, name: `${r.jobId}-item-${newIndex}` };
            }
            return r;
          })
      );

      if (this.selectedReport()?.name === report.name) {
        this.selectedReport.set(null);
        this.metadata.set(null);
      }

      this.notify('success', 'Deleted', 'Report deleted.');
    } catch (error: any) {
      this.notify('error', 'Delete failed', error?.message || String(error));
    }
  }

  // ── Selection / export ─────────────────────────────────────────────────────

  toggleSelection(report: MetadataReport, event: Event): void {
    event.stopPropagation();
    this.reports.update((reports) =>
      reports.map((r) => (r.name === report.name ? { ...r, selected: !r.selected } : r))
    );
  }

  toggleSelectAll(): void {
    const allSelected = this.allReportsSelected();
    this.reports.update((reports) => reports.map((r) => ({ ...r, selected: !allSelected })));
  }

  getSelectedReports(): MetadataReport[] {
    return this.reports().filter((r) => r.selected);
  }

  hasSelectedReports(): boolean {
    return this.reports().some((r) => r.selected);
  }

  allReportsSelected(): boolean {
    return this.reports().length > 0 && this.reports().every((r) => r.selected);
  }

  async exportSelectedAsTxt(): Promise<void> {
    const selected = this.getSelectedReports();
    if (selected.length === 0) return;

    try {
      const result = await this.electron.selectOutputDirectory();
      if (!result?.success || !result.directory) return; // Cancelled

      const exportDir = result.directory;
      let successCount = 0;
      const failures: string[] = [];

      for (const report of selected) {
        try {
          const content = await this.electron.readFile(report.path);
          if (!content) throw new Error('empty report file');

          const jobData = JSON.parse(content);
          if (report.itemIndex === undefined) throw new Error('no itemIndex');
          if (!Array.isArray(jobData.items)) throw new Error('no items array');
          if (jobData.items.length <= report.itemIndex) throw new Error('item index out of bounds');

          const metadata = this.normalizeMetadataKeys(jobData.items[report.itemIndex]);
          const safeName = (report.displayTitle || report.name).replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 100);
          await this.electron.writeTextFile(
            `${exportDir}/${safeName}_metadata.txt`,
            this.formatMetadataAsTxt(metadata, report)
          );
          successCount++;
        } catch (error) {
          failures.push(`${report.displayTitle || report.name}: ${(error as Error).message}`);
        }
      }

      if (successCount > 0) {
        this.notify('success', 'Export complete', `Exported ${successCount} file(s) to ${exportDir}`);
      }
      // Every failure is named. "3 files failed" is not something anyone can act on.
      if (failures.length > 0) {
        this.notify('error', 'Export incomplete', `${failures.length} failed:\n${failures.join('\n')}`);
      }

      this.reports.update((reports) => reports.map((r) => ({ ...r, selected: false })));
    } catch (error: any) {
      this.notify('error', 'Export failed', error?.message || String(error));
    }
  }

  private formatMetadataAsTxt(metadata: ParsedMetadata, report: MetadataReport): string {
    const rule = '='.repeat(80);
    const descText = metadata.description ? this.getDescriptionText(metadata.description) : '';
    let output = '';

    output += `${rule}\n`;
    output += 'METADATA EXPORT\n';
    output += `Title: ${metadata._title || report.displayTitle || report.name}\n`;
    output += `Prompt Set: ${metadata._prompt_set || report.promptSet || 'N/A'}\n`;
    output += `Generated: ${report.date.toLocaleString()}\n`;
    output += `${rule}\n\n`;

    const numberedSection = (heading: string, values?: string[]) => {
      if (!values?.length) return;
      output += `--- ${heading} ---\n\n`;
      values.forEach((v, i) => {
        output += `${i + 1}. ${v}\n`;
      });
      output += '\n';
    };

    numberedSection('TITLES', metadata.titles);
    numberedSection('THUMBNAIL TEXT', metadata.thumbnail_text);
    numberedSection('PINNED COMMENT', metadata.pinned_comment);
    numberedSection('CLIP SUGGESTIONS', metadata.clip_suggestions);

    if (metadata.chapters?.length) {
      output += '--- CHAPTERS ---\n\n';
      metadata.chapters.forEach((c) => {
        output += `${this.getChapterTimestamp(c)} - ${this.getChapterTitle(c)}\n`;
      });
      output += '\n';
    }

    if (descText) {
      output += '--- DESCRIPTION ---\n\n';
      output += `${descText}\n\n`;
    }

    if (metadata.tags) {
      output += '--- TAGS ---\n\n';
      output += `${Array.isArray(metadata.tags) ? metadata.tags.join(', ') : metadata.tags}\n\n`;
    }

    // Only when the description does not already carry them — otherwise the export reads
    // as if the hashtags were meant twice.
    if (metadata.hashtags && !descText.includes(metadata.hashtags)) {
      output += '--- HASHTAGS ---\n\n';
      output += `${metadata.hashtags}\n\n`;
    }

    output += `${rule}\nEnd of metadata export\n`;
    return output;
  }

  // ── Clipboard ──────────────────────────────────────────────────────────────

  copyToClipboard(text: string, itemKey?: string): void {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        if (itemKey) this.setCopiedItem(itemKey);
      })
      .catch((err) => this.notify('error', 'Copy failed', err?.message || String(err)));
  }

  copyChapters(): void {
    const meta = this.metadata();
    if (!meta?.chapters) return;
    const text = meta.chapters
      .map((c) => `${this.getChapterTimestamp(c)} - ${this.getChapterTitle(c)}`)
      .join('\n');
    this.copyToClipboard(text, 'chapters-all');
  }

  private setCopiedItem(key: string): void {
    if (this.copiedTimeout) clearTimeout(this.copiedTimeout);
    this.copiedItem.set(key);
    this.copiedTimeout = setTimeout(() => this.copiedItem.set(null), 1500);
  }

  isCopied(key: string): boolean {
    return this.copiedItem() === key;
  }

  // ── Display helpers ────────────────────────────────────────────────────────

  formatDate(date: Date): string {
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }

  getTagsArray(): string[] {
    const meta = this.metadata();
    if (!meta?.tags) return [];
    if (Array.isArray(meta.tags)) return meta.tags;
    return meta.tags.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
  }

  getTagsString(): string {
    return this.getTagsArray().join(', ');
  }

  // Models return either a plain string or an object; both have to render as a string, and
  // "[object Object]" on screen is what happens when they don't.
  getTitleText(title: any): string {
    if (typeof title === 'string') return title;
    if (title && typeof title === 'object' && title.text) return title.text;
    return String(title);
  }

  getDescriptionText(description: any): string {
    if (typeof description === 'string') return description;
    if (description && typeof description === 'object') {
      if (description.text) return description.text;
      if (description.content) return description.content;
      if (description.description) return description.description;
    }
    return String(description || '');
  }

  getThumbnailText(thumbnail: any): string {
    if (typeof thumbnail === 'string') return thumbnail;
    if (thumbnail && typeof thumbnail === 'object' && thumbnail.text) return thumbnail.text;
    return String(thumbnail);
  }

  getChapterTimestamp(chapter: any): string {
    if (typeof chapter === 'string') {
      const match = chapter.match(/^(\d+:\d+)/);
      return match ? match[1] : '0:00';
    }
    if (chapter && typeof chapter === 'object') {
      if (chapter.timestamp) return String(chapter.timestamp);
      if (chapter.time) return String(chapter.time);
    }
    return '0:00';
  }

  getChapterTitle(chapter: any): string {
    if (typeof chapter === 'string') {
      const match = chapter.match(/^\d+:\d+\s*-\s*(.+)$/);
      return match ? match[1] : chapter;
    }
    if (chapter && typeof chapter === 'object') {
      if (chapter.title) return String(chapter.title);
      if (chapter.text) return String(chapter.text);
      if (chapter.name) return String(chapter.name);
    }
    return String(chapter || 'Untitled');
  }

  /**
   * Fold the key names different models use onto the fields this page renders, and flatten
   * any object-shaped value to a string. Without this a model that answers `titleOptions`
   * instead of `titles` renders an empty Titles section and looks like a failed run.
   */
  private normalizeMetadataKeys(raw: any): ParsedMetadata {
    const toStr = (val: any): string => {
      if (typeof val === 'string') return val;
      if (val && typeof val === 'object') {
        return val.text || val.title || val.value || val.content || val.label || JSON.stringify(val);
      }
      return String(val ?? '');
    };

    const toStrArray = (arr: any): string[] => {
      if (!arr) return [];
      if (!Array.isArray(arr)) return [toStr(arr)];
      return arr.map(toStr);
    };

    // Tags lose any leading '#': YouTube's tag field wants bare words, and a tag typed in
    // as "#atheism" is silently rejected there.
    let tags: string | string[] = raw.tags || '';
    if (Array.isArray(tags)) {
      tags = tags.map((t: any) => toStr(t).replace(/^#\s*/, ''));
    } else if (typeof tags === 'string') {
      tags = tags.split(',').map((t: string) => t.trim().replace(/^#\s*/, '')).join(',');
    }

    return {
      titles: toStrArray(raw.titles || raw.titleOptions || raw.title_options || raw.titleSuggestions),
      thumbnail_text: toStrArray(
        raw.thumbnail_text || raw.thumbnailText || raw.thumbnailTextOptions || raw.thumbnail_text_options || raw.thumbnailOptions
      ),
      description: raw.description || '',
      tags,
      hashtags: raw.hashtags || '',
      pinned_comment: toStrArray(raw.pinned_comment || raw.pinnedComment || raw.pinned_comments),
      clip_suggestions: toStrArray(raw.clip_suggestions || raw.clipSuggestions || raw.clips),
      chapters: raw.chapters,
      _title: raw._title,
      _prompt_set: raw._prompt_set,
    };
  }

  trackByReportName(_index: number, report: MetadataReport): string {
    return report.name;
  }

  trackByIndex(index: number): number {
    return index;
  }
}
