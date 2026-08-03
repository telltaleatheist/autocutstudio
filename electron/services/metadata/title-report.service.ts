/**
 * Title Report Service
 *
 * Persists ONE titling run as a report in the SAME store the metadata pipeline writes to —
 * `<outputDirectory>/.contentstudio/metadata/*.json` — so the Reports page lists it with no
 * change to that page at all. A titling job produces no transcript, no TXT file and no
 * output folder, so it cannot go through OutputHandlerService (which builds a TXT folder and
 * a readable TXT per item); this writes the JSON half only, matching that service's
 * conventions where they apply (same directory, same `items` array, same sanitize/de-collide
 * rules for the filename).
 *
 * The file is named `titles-<slug>-<yyyymmdd-hhmmss>.json` rather than `<jobId>.json`. Two
 * reasons, both deliberate:
 *   - it is legible in a folder listing a month later, which is the whole access pattern;
 *   - 'get-job-history' auto-prunes `job-*.json` older than four weeks. Titles are meant to
 *     be kept, so the report deliberately does not carry that prefix and is never pruned.
 */

import * as fs from 'fs';
import * as path from 'path';

/** One title candidate set, as the Reports page's ParsedMetadata reads it. */
export interface TitleReportItem {
  /** The story's name. The Reports list shows this as the row title (`item._title`). */
  _title: string;
  /** GENERATION order, verbatim from the model. The page's in-band-first ordering is a
   *  display concern and must not be baked into the record. */
  titles: string[];

  // ── Provenance. The Reports viewer ignores unknown item fields (normalizeMetadataKeys
  //    projects onto a fixed shape), so these ride along without touching that page.
  generator: string;
  kind: 'story-titles';
  model: string;
  format: 'normal' | 'livestream';
  target: string;
  /** The subject lines the model actually saw, as the main process parsed them. */
  subjects: string[];
  /** The trained character band the badges are judged against. */
  titleBand: { min: number; max: number };
  /** Indexes INTO `titles` (generation order) that fell outside `titleBand`. */
  outOfBand: number[];
  generatedAt: string;

  // RESERVED, and deliberately ABSENT until the adapters that fill them ship:
  //   description  — the written description for this video
  //   tags         — its tag list
  //   chapters     — its chapter list, which will be rendered INTO the description
  // The Reports viewer already renders all three when present (each section is *ngIf'd on
  // its own field), so adding them later is a writer change only.
}

/** The job wrapper. Field names are the metadata store's, because the Reports page reads them. */
export interface TitleReport {
  job_id: string;
  job_name: string;
  created_at: string;
  /** Present and empty on purpose: a titling run writes no TXT files and owns no folder.
   *  The Reports page reads both (`jobData.txt_folder || ''`, `jobData.txt_files?.[i] || ''`)
   *  and falls back to the JSON itself for "Show in folder". */
  txt_folder: string;
  txt_files: string[];
  status: string;
  /** Job-level echo of the item's provenance, so the store can be filtered without opening
   *  every item. */
  kind: 'story-titles';
  generator: string;
  items: TitleReportItem[];
}

export interface SaveTitleReportResult {
  saved: true;
  path: string;
}

/**
 * Sanitize a story name for use in a filename. Same rules as
 * OutputHandlerService.sanitizeFilename (path separators / reserved characters / control
 * chars → space, whitespace collapsed, trimmed, length-capped) with one addition: spaces
 * become dashes and the result is lower-cased, because this is a slug inside a longer
 * generated name rather than a title standing alone as a TXT filename.
 *
 * Unicode LETTERS survive, deliberately: a story called “Ken Ham’s Ark” should be findable
 * under that name rather than under a mangled transliteration. Dash-like punctuation (– —)
 * folds into the slug dash, apostrophes vanish (lockes, not locke-s), and shell-hostile
 * marks (& ' ") become dashes — real filenames were coming out as `…-—-greg-locke's-…`,
 * which is legal but miserable to type or tab-complete.
 */
export function slugifyStoryName(name: string): string {
  const clean = (name || '')
    .replace(/[/\\:*?"<>|\x00-\x1F]/g, ' ')
    .replace(/['’‘]/g, '')
    .replace(/[—–&]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');

  const MAX_LEN = 80;
  return clean.length > MAX_LEN ? clean.slice(0, MAX_LEN).replace(/-+$/, '') : clean;
}

/** `yyyymmdd-hhmmss` in LOCAL time — the report is read by the person who ran it. */
export function reportTimestamp(date: Date): string {
  const p = (n: number, width = 2) => String(n).padStart(width, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

/**
 * De-collide `<baseName>.json` inside `dir` with a numeric suffix, exactly as
 * OutputHandlerService.resolveUniqueTxtPath does for TXT files. Two stories titled in the
 * same second is unlikely but not impossible, and overwriting one with the other would lose
 * a run without saying so.
 */
function resolveUniqueJsonPath(dir: string, baseName: string): string {
  let candidate = path.join(dir, `${baseName}.json`);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${baseName} (${counter}).json`);
    counter++;
  }
  return candidate;
}

/**
 * Write one titling report into `<outputDirectory>/.contentstudio/metadata/`.
 *
 * Throws on a genuine write failure (unwritable directory, full disk) with the real error —
 * the caller is expected to surface that, not swallow it. '.contentstudio' is the on-disk
 * contract the Reports page reads; see OutputHandlerService's constructor for why the name
 * is not this app's.
 */
export function saveTitleReport(outputDirectory: string, report: TitleReport): SaveTitleReportResult {
  const metadataDir = path.join(outputDirectory, '.contentstudio', 'metadata');
  fs.mkdirSync(metadataDir, { recursive: true });

  // The job carries the Metadata page's display name ("Chapters — <story>"); in a folder of
  // title reports that prefix says nothing, so the filename drops it and keeps the story.
  const storyName = report.job_name.replace(/^chapters\s*[—–-]\s*/i, '');
  const slug = slugifyStoryName(storyName) || 'story';
  const baseName = `titles-${slug}-${reportTimestamp(new Date(report.created_at))}`;
  const jsonPath = resolveUniqueJsonPath(metadataDir, baseName);

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf-8');

  return { saved: true, path: jsonPath };
}
