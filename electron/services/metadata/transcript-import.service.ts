/**
 * Transcript Import Service
 *
 * Imports a per-story transcript JSON produced by a sister app (AutoCutStudio)
 * and converts it into ContentStudio's native transcript representation
 * (a ContentItem with plain-text `content` + timestamped `srtSegments`), so the
 * project skips Whisper entirely and lands in the exact "transcript ready" state
 * a freshly-transcribed project reaches.
 *
 * The import file is one JSON per story. The canonical shape ContentStudio
 * consumes is documented in TranscriptImportFile below; the parser is tolerant
 * and also accepts AutoCutStudio's native sidecar field names as aliases
 * (`track`->speaker, `timelineStart/End`->start/end, `tracks`->speakers,
 * `session`->sourceSession, `schemaVersion`->formatVersion, `prob`->confidence).
 */

import * as path from 'path';
import type { SRTSegment } from './whisper.service';
import type { ContentItem } from './input-handler.service';

/** A suggested split point, in the story's own 0-based timeline. Used by the
 *  (future) subject-drift split feature and the AutoCutStudio round-trip. Carried
 *  on imported projects so split timestamps + labels can later be emitted back. */
export interface SplitSuggestion {
  /** 1-based order of this split within the story. */
  index?: number;
  /** Where the new segment begins, seconds on the story's 0-based timeline. */
  startSeconds: number;
  /** Where the segment ends (optional; usually the next split's start). */
  endSeconds?: number;
  /** Human-readable timestamp mirror of startSeconds (H:MM:SS). */
  timestamp: string;
  /** Short label for the new subject/segment (e.g. "Shift to immigration"). */
  label: string;
  /** Optional one-line reason the split was suggested (subject drift cue). */
  rationale?: string;
}

/** Speaker/track identity carried through import (mic vs screen audio, etc.). */
export interface ImportSpeaker {
  id: string;
  label: string;
}

/** Story identity + provenance, preserved on the ContentItem so a later phase
 *  can emit split suggestions back to AutoCutStudio correlated to the right
 *  session/story. Nothing downstream requires this today. */
export interface TranscriptImportMeta {
  formatVersion?: number;
  producer?: string;
  /** AutoCutStudio session name this story was sliced from (round-trip key). */
  sourceSession?: string;
  story: {
    number?: number;
    title: string;
    slug?: string;
    /** Story's start offset on the session-global timeline, if known. Lets
     *  story-local split suggestions be converted back to session time. */
    startSeconds?: number;
  };
  language: string;
  durationSeconds?: number;
  /** Whether word times were story-local ('story', default) or session-global
   *  ('session', rebased to 0 on import). */
  timebase: 'story' | 'session';
  speakers: ImportSpeaker[];
  /** Suggested split points (empty until the split feature is run). */
  splitSuggestions?: SplitSuggestion[];
}

/**
 * The canonical inter-app import file (what CS asks AutoCutStudio to emit).
 * All fields except `words` are optional/tolerated; see parser for fallbacks.
 */
export interface TranscriptImportFile {
  formatVersion?: number;
  producer?: string;
  sourceSession?: string;
  story?: { number?: number; title?: string; slug?: string; startSeconds?: number };
  language?: string;
  durationSeconds?: number;
  timebase?: 'story' | 'session';
  speakers?: Array<{ id: string; label?: string }>;
  words?: Array<{
    speaker?: string;
    text?: string;
    start?: number;
    end?: number;
    confidence?: number;
    // AutoCutStudio native-sidecar aliases:
    track?: string;
    timelineStart?: number;
    timelineEnd?: number;
    fileStart?: number;
    fileEnd?: number;
    prob?: number;
  }>;
  splitSuggestions?: SplitSuggestion[];
  // AutoCutStudio native-sidecar aliases:
  schemaVersion?: number;
  session?: string;
  tracks?: Array<{ id: string; label?: string }>;
}

/** A normalized word after parsing (times are story-local, 0-based). */
interface NormalizedWord {
  speaker?: string;
  text: string;
  start: number;
  end: number;
  confidence?: number;
}

/** Fully parsed + validated import, ready to build a ContentItem. */
export interface ParsedTranscriptImport {
  meta: TranscriptImportMeta;
  words: NormalizedWord[];
  /** Lightweight summary for the import UI (title/speakers/counts). */
  summary: {
    title: string;
    slug?: string;
    number?: number;
    sourceSession?: string;
    language: string;
    durationSeconds: number;
    speakers: ImportSpeaker[];
    wordCount: number;
  };
}

export type ParseResult =
  | { ok: true; data: ParsedTranscriptImport }
  | { ok: false; error: string };

// Segmentation tuning — chosen so segments resemble Whisper subtitle lines.
const SEGMENT_GAP_SECONDS = 0.8;   // start a new segment after a pause this long
const SEGMENT_MAX_WORDS = 16;      // hard cap on words per segment
const SEGMENT_MAX_SECONDS = 10;    // hard cap on segment duration
const SEGMENT_MIN_WORDS = 4;       // don't break on punctuation below this many words
const SENTENCE_END = /[.!?…]["'”’)\]]?$/;

function toNumber(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Convert seconds to an SRT timestamp string "HH:MM:SS,mmm" (matches whisper). */
export function secondsToSrtTime(totalSeconds: number): string {
  let t = Number.isFinite(totalSeconds) && totalSeconds > 0 ? totalSeconds : 0;
  let whole = Math.floor(t);
  let ms = Math.round((t - whole) * 1000);
  if (ms === 1000) { ms = 0; whole += 1; }
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const p2 = (n: number) => n.toString().padStart(2, '0');
  const p3 = (n: number) => n.toString().padStart(3, '0');
  return `${p2(hours)}:${p2(minutes)}:${p2(secs)},${p3(ms)}`;
}

/** Convert seconds to a compact H:MM:SS / M:SS label (for split suggestions). */
export function secondsToClock(totalSeconds: number): string {
  const t = Number.isFinite(totalSeconds) && totalSeconds > 0 ? totalSeconds : 0;
  const hours = Math.floor(t / 3600);
  const minutes = Math.floor((t % 3600) / 60);
  const secs = Math.floor(t % 60);
  const p2 = (n: number) => n.toString().padStart(2, '0');
  return hours > 0 ? `${hours}:${p2(minutes)}:${p2(secs)}` : `${minutes}:${p2(secs)}`;
}

function prettifySpeakerId(id: string): string {
  const cleaned = id
    .replace(/_(voiceiso|processed|audio)$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (!cleaned) return id;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function deriveTitleFromPath(filePath: string): string {
  const base = path.basename(filePath).replace(/\.[^/.]+$/, '');
  // "2_jack-posobiec" / "jack-posobiec" -> "Jack Posobiec"
  const words = base
    .replace(/^\d+[_\-.\s]+/, '')  // strip a leading story number
    .replace(/[_-]+/g, ' ')
    .trim();
  if (!words) return base;
  return words.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Parse + validate a raw import JSON string. Tolerant: only a non-empty set of
 * words with text is strictly required; everything else has a sane fallback.
 */
export function parseTranscriptImport(rawJson: string, filePath: string): ParseResult {
  let raw: TranscriptImportFile;
  try {
    raw = JSON.parse(rawJson);
  } catch (err) {
    return { ok: false, error: `File is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'Transcript file is empty or not a JSON object.' };
  }

  const rawWords = Array.isArray(raw.words) ? raw.words : [];
  if (rawWords.length === 0) {
    return { ok: false, error: 'Transcript file contains no "words" array.' };
  }

  // Normalize words (accepting AutoCutStudio native aliases).
  const words: NormalizedWord[] = [];
  for (const w of rawWords) {
    const text = String(w?.text ?? '').trim();
    if (!text) continue;
    const start = toNumber(w?.start ?? w?.timelineStart ?? w?.fileStart, NaN);
    const end = toNumber(w?.end ?? w?.timelineEnd ?? w?.fileEnd, NaN);
    const speaker = (w?.speaker ?? w?.track) as string | undefined;
    const confidence = w?.confidence ?? w?.prob;
    words.push({
      speaker: speaker != null ? String(speaker) : undefined,
      text,
      start: Number.isFinite(start) ? start : 0,
      end: Number.isFinite(end) ? end : (Number.isFinite(start) ? start : 0),
      confidence: typeof confidence === 'number' ? confidence : undefined,
    });
  }

  if (words.length === 0) {
    return { ok: false, error: 'Transcript file has words but none contain text.' };
  }

  // Chronological order; mic/screen tracks can interleave, so sort by start.
  words.sort((a, b) => (a.start - b.start) || (a.speaker || '').localeCompare(b.speaker || ''));

  // Rebase session-global times to a story-local 0 base when requested.
  const timebase: 'story' | 'session' = raw.timebase === 'session' ? 'session' : 'story';
  let storyStartSeconds = raw.story?.startSeconds;
  if (timebase === 'session') {
    const offset = Number.isFinite(storyStartSeconds as number)
      ? (storyStartSeconds as number)
      : words[0].start;
    if (offset > 0) {
      for (const w of words) {
        w.start = Math.max(0, w.start - offset);
        w.end = Math.max(w.start, w.end - offset);
      }
    }
    storyStartSeconds = offset;
  }

  // Speakers: explicit list, else AutoCutStudio `tracks`, else derived from words.
  const rawSpeakers = raw.speakers ?? raw.tracks;
  let speakers: ImportSpeaker[];
  if (Array.isArray(rawSpeakers) && rawSpeakers.length > 0) {
    speakers = rawSpeakers.map((s) => ({
      id: String(s.id),
      label: s.label ? String(s.label) : prettifySpeakerId(String(s.id)),
    }));
  } else {
    const seen = new Map<string, ImportSpeaker>();
    for (const w of words) {
      if (w.speaker && !seen.has(w.speaker)) {
        seen.set(w.speaker, { id: w.speaker, label: prettifySpeakerId(w.speaker) });
      }
    }
    speakers = Array.from(seen.values());
  }

  const title = (raw.story?.title && String(raw.story.title).trim()) || deriveTitleFromPath(filePath);
  const language = (raw.language && String(raw.language)) || 'en';
  const lastEnd = words[words.length - 1].end;
  const durationSeconds = Number.isFinite(raw.durationSeconds as number) && (raw.durationSeconds as number) > 0
    ? (raw.durationSeconds as number)
    : lastEnd;

  const meta: TranscriptImportMeta = {
    formatVersion: raw.formatVersion ?? raw.schemaVersion,
    producer: raw.producer,
    sourceSession: raw.sourceSession ?? raw.session,
    story: {
      number: raw.story?.number,
      title,
      slug: raw.story?.slug,
      startSeconds: storyStartSeconds,
    },
    language,
    durationSeconds,
    timebase,
    speakers,
    splitSuggestions: Array.isArray(raw.splitSuggestions) ? raw.splitSuggestions : [],
  };

  return {
    ok: true,
    data: {
      meta,
      words,
      summary: {
        title,
        slug: raw.story?.slug,
        number: raw.story?.number,
        sourceSession: meta.sourceSession,
        language,
        durationSeconds,
        speakers,
        wordCount: words.length,
      },
    },
  };
}

/** Join a run of word texts into a clean segment string. */
function joinWords(words: NormalizedWord[]): string {
  return words
    .map((w) => w.text.trim())
    .join(' ')
    .replace(/\s+([,.!?;:…])/g, '$1')   // no space before punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Group words into Whisper-like SRT segments, breaking on speaker change, long
 * pauses, sentence endings, or the size caps. Each segment carries its speaker.
 */
export function wordsToSegments(words: NormalizedWord[], speakers: ImportSpeaker[]): SRTSegment[] {
  const labelById = new Map(speakers.map((s) => [s.id, s.label]));
  const segments: SRTSegment[] = [];
  let bucket: NormalizedWord[] = [];
  let index = 1;

  const flush = () => {
    if (bucket.length === 0) return;
    const first = bucket[0];
    const last = bucket[bucket.length - 1];
    const text = joinWords(bucket);
    if (text) {
      const seg: SRTSegment = {
        index: index++,
        start: secondsToSrtTime(first.start),
        end: secondsToSrtTime(last.end),
        text,
      };
      if (first.speaker) {
        seg.speaker = first.speaker;
        seg.speakerLabel = labelById.get(first.speaker) ?? prettifySpeakerId(first.speaker);
      }
      segments.push(seg);
    }
    bucket = [];
  };

  for (const word of words) {
    if (bucket.length > 0) {
      const prev = bucket[bucket.length - 1];
      const segStart = bucket[0].start;
      const speakerChanged = (word.speaker || '') !== (prev.speaker || '');
      const bigGap = word.start - prev.end > SEGMENT_GAP_SECONDS;
      const tooManyWords = bucket.length >= SEGMENT_MAX_WORDS;
      const tooLong = word.end - segStart > SEGMENT_MAX_SECONDS;
      const sentenceBreak = SENTENCE_END.test(prev.text) && bucket.length >= SEGMENT_MIN_WORDS;
      if (speakerChanged || bigGap || tooManyWords || tooLong || sentenceBreak) {
        flush();
      }
    }
    bucket.push(word);
  }
  flush();

  return segments;
}

/**
 * Build the plain-text transcript the AI summarizer/metadata stage consumes.
 * When more than one speaker is present, attribution is preserved by prefixing
 * each speaker change with its label (screenplay style), e.g.:
 *   "Mic: ... host commentary ...
 *
 *    Screen audio: ... reacted-to clip ..."
 * With a single speaker it's just the joined transcript (no noise).
 */
export function buildContentText(segments: SRTSegment[], speakers: ImportSpeaker[]): string {
  const multiSpeaker = new Set(segments.map((s) => s.speaker).filter(Boolean)).size > 1;
  if (!multiSpeaker) {
    return segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
  }

  const parts: string[] = [];
  let lastSpeaker: string | undefined | null = null;
  for (const seg of segments) {
    if (seg.speaker !== lastSpeaker) {
      const label = seg.speakerLabel ?? seg.speaker ?? 'Speaker';
      parts.push(`\n\n${label}: ${seg.text}`);
      lastSpeaker = seg.speaker;
    } else {
      parts.push(seg.text);
    }
  }
  return parts.join(' ').replace(/[ \t]+/g, ' ').replace(/ *\n/g, '\n').trim();
}

/**
 * Convert a parsed import into a ContentItem — the same shape Whisper produces,
 * so the whole downstream pipeline (summarize, metadata, chapters) runs unchanged.
 * `source` is set to the import file path so per-item chapter flags match; a
 * `title` (the story title) is attached so the project reads as the story name.
 */
export function buildImportedContentItem(
  parsed: ParsedTranscriptImport,
  filePath: string,
  customNotes?: string,
): ContentItem {
  const segments = wordsToSegments(parsed.words, parsed.meta.speakers);
  let content = buildContentText(segments, parsed.meta.speakers);

  if (customNotes && customNotes.trim()) {
    content += `\n\nAdditional context:\n${customNotes.trim()}`;
  }

  return {
    content,
    contentType: 'transcript_file',
    source: filePath,
    title: parsed.meta.story.title,
    processingNotes: customNotes?.trim(),
    srtSegments: segments,
    importMeta: parsed.meta,
  };
}

/** A user-finalized cut range within the story's 0-based timeline. */
export interface TranscriptSliceCut {
  startSeconds: number;
  endSeconds: number;
  /** Optional AI subject label (informational; not used as the project title). */
  title?: string;
}

/** One materialized slice: a self-contained import file plus display metadata. */
export interface TranscriptSliceResult {
  /** Ready to JSON.stringify and write as a standalone transcript-import file. */
  file: TranscriptImportFile;
  /** Project/display name for the resulting queue item ("<title> — Part N"). */
  displayName: string;
  slug?: string;
  startSeconds: number;      // range on the ORIGINAL story timeline
  endSeconds: number;
  durationSeconds: number;
  wordCount: number;
}

/**
 * Split a parsed transcript into N standalone import files at the given cuts.
 * Each slice's word times are rebased to a 0 base so it reads as its own story;
 * `story.startSeconds` carries the original offset for provenance / the ACS
 * round-trip. The output files parse back through this same service unchanged,
 * so each slice becomes a normal transcript-import queue item (no Whisper).
 */
export function buildTranscriptSlices(
  parsed: ParsedTranscriptImport,
  cuts: TranscriptSliceCut[],
): TranscriptSliceResult[] {
  const ordered = [...cuts].sort((a, b) => a.startSeconds - b.startSeconds);
  const baseTitle = parsed.meta.story.title;
  const baseSlug = parsed.meta.story.slug;
  const storyStart = parsed.meta.story.startSeconds ?? 0;
  const results: TranscriptSliceResult[] = [];

  ordered.forEach((cut, i) => {
    const partNum = i + 1;
    const start = Math.max(0, cut.startSeconds);
    const end = cut.endSeconds;

    // A word belongs to the slice that its START falls into — keeps every word in
    // exactly one slice and matches how the boundary was chosen (segment start).
    const sliceWords = parsed.words
      .filter((w) => w.start >= start && w.start < end)
      .map((w) => ({
        speaker: w.speaker,
        text: w.text,
        start: Math.max(0, w.start - start),
        end: Math.max(0, w.end - start),
        confidence: w.confidence,
      }));

    const lastEnd = sliceWords.length ? sliceWords[sliceWords.length - 1].end : Math.max(0, end - start);
    // Prefer the user-supplied story name; fall back to "<title> — Part N".
    const displayName = cut.title?.trim() || `${baseTitle} — Part ${partNum}`;

    const file: TranscriptImportFile = {
      formatVersion: parsed.meta.formatVersion,
      producer: parsed.meta.producer,
      sourceSession: parsed.meta.sourceSession,
      story: {
        number: parsed.meta.story.number,
        title: displayName,
        slug: baseSlug ? `${baseSlug}-part-${partNum}` : undefined,
        startSeconds: storyStart + start,
      },
      language: parsed.meta.language,
      durationSeconds: lastEnd,
      timebase: 'story',
      speakers: parsed.meta.speakers.map((s) => ({ id: s.id, label: s.label })),
      words: sliceWords,
      splitSuggestions: [],
    };

    results.push({
      file,
      displayName,
      slug: file.story?.slug,
      startSeconds: start,
      endSeconds: end,
      durationSeconds: Math.max(0, end - start),
      wordCount: sliceWords.length,
    });
  });

  return results;
}

/** True if a file path is a candidate for transcript import (a .json file). */
export function isTranscriptImportPath(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.json';
}
