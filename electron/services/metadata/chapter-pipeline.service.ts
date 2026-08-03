/**
 * Chapter Pipeline Service — the sealed 14B chaptering method
 *
 * Implements CHAPTERING.md (sealed 2026-08-02): label -> rate -> select -> place ->
 * summarize -> consolidate. Chapters are the FIRST stage of metadata generation; the
 * resulting subject list is what the title, description and tag stages condition on.
 *
 * THE ONE LAW: a 14B cannot select K items from a list of N. Ask it which 12 of 70
 * candidate boundaries are real and it returns a prefix and stops. So no model call
 * here ever sees a list, a count, or the whole video. Every call asks ONE local
 * question about ONE thing, and this file does all the counting, ranking, spacing and
 * assembling. Five architectures died before that was isolated — if you find yourself
 * adding a prompt that shows the model more than one boundary at a time, stop.
 *
 * The model never emits a timestamp either. It quotes a verbatim sentence and
 * mapQuote() measures where that sentence falls in the caption word stream.
 *
 * Everything runs at temperature 0 with format:json. Single-video results at temp > 0
 * are not measurements — the same config scored 0.50 then 0.00 on consecutive runs.
 *
 * Ported from ContentStudio (electron/services/metadata/chapter-pipeline.service.ts).
 * ADAPTED: transport only — axios became the built-in `fetch`, so no axios dependency is
 * pulled in for one file. The wire request is byte-identical.
 *
 * This is the ONE Ollama caller in the app that does NOT go through
 * services/ollama-service.ts, and the reason is two fields that service does not expose:
 *   - `keep_alive: '10m'` on every call. A run is hundreds of short calls; under Ollama's
 *     default 5m idle eviction a slow machine can drop the model MID-RUN and reload a 14B
 *     between stages, turning a 25-minute run into an hour.
 *   - `done_reason` on the response. Hitting the num_predict ceiling is a HARD FAILURE here
 *     (truncated JSON), not a warning. Without the field the only remaining signal is
 *     JSON.parse failing, which a truncation that happens to land on a valid boundary would
 *     slip past — and a chapter list that silently lost a boundary is unfixable by hand and
 *     poisons every other metadata field.
 * Routing this through ollama-service would trade a tuned, sealed method for a slower one
 * with a weaker correctness guard. If those two fields are ever surfaced there, collapse
 * this onto it.
 */

import * as log from 'electron-log';
import { SRTSegment } from './whisper.service';
import { Chapter, TimeUtils } from './chapter-generator.service';
import { CHAPTER_PROMPTS } from './chapter-prompts';
import { formatPrompt } from './system-prompts';

export type ChapterStage = 'label' | 'rate' | 'place' | 'summarize' | 'consolidate';

export interface ChapterPipelineOptions {
  /** Ollama base URL. */
  host: string;
  /** Model used for every stage that has no override. No provider prefix. */
  model: string;
  /**
   * Per-stage model overrides.
   *
   * CHAPTERING.md validates qwen2.5:14b as the RATER (healthy 0-3 spread) and notes
   * cogito:14b rates with almost no variance on some corpora while being fine for the
   * label stage — "when in doubt, run qwen2.5:14b for stages 2, 4 and 5". This hook is
   * how you act on that without a code change; it is deliberately not defaulted, so
   * the configured model is the model that runs.
   */
  stageModels?: Partial<Record<ChapterStage, string>>;
  /**
   * Context window. One value for the WHOLE run on purpose: Ollama reloads the model
   * whenever num_ctx changes, and a run makes hundreds of calls. 16384 is the floor
   * for summarizing a ~18-minute consolidated chapter.
   */
  numCtx?: number;
  onProgress?: (stage: ChapterStage, done: number, total: number) => void;
  cancelCallback?: () => boolean;
}

export interface ChapterPipelineResult {
  chapters: Chapter[];
  /** Chapter subjects in order, timestamps stripped — the input to every downstream field. */
  subjects: string[];
  stats: {
    durationSeconds: number;
    stretches: number;
    junctions: number;
    boundariesSelected: number;
    chaptersBeforeConsolidation: number;
    chaptersAfterConsolidation: number;
    calls: number;
  };
}

/** Stage 1 cuts the transcript into stretches this long. */
const STRETCH_SECONDS = 45;
/** YouTube refuses a chapter list with fewer than 3 entries; also the over-collapse floor. */
const MIN_CHAPTERS = 3;
const DEFAULT_NUM_CTX = 16384;
/** Outputs are one-line JSON objects; 512 is far more than any stage needs. */
const NUM_PREDICT = 512;
const CALL_TIMEOUT_MS = 600_000;
/** Long enough to span the gap between consecutive calls, so the model stays resident. */
const KEEP_ALIVE = '10m';
/** Exact-match probe length for quote -> timestamp mapping. */
const QUOTE_PROBE_WORDS = 12;
/** Best fractional match below this is not a measurement — it is a coincidence. */
const QUOTE_MATCH_THRESHOLD = 0.5;

/**
 * Cadence measured across 3,000+ published chapters. Drives both the target chapter
 * count and the minimum spacing between selected boundaries.
 */
function targetSecondsFor(durationSeconds: number): number {
  if (durationSeconds < 10 * 60) return 2.2 * 60;
  if (durationSeconds < 30 * 60) return 3.5 * 60;
  if (durationSeconds < 60 * 60) return 5.6 * 60;
  return 6 * 60;
}

/** Lowercase, drop apostrophes, split on anything else. Contractions stay one word. */
function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

/** One caption cue, with its slice of the flattened word stream. */
interface Cue {
  startSec: number;
  endSec: number;
  text: string;
  wordStart: number;
  wordEnd: number; // exclusive
}

/** A 45-second stretch of cues — the unit stage 1 labels and stage 2 rates across. */
interface Stretch {
  index: number;
  startSec: number;
  endSec: number;
  text: string;
  wordStart: number;
  wordEnd: number; // exclusive
}

/**
 * The flattened caption word stream.
 *
 * Mapping MUST run against this, not against individual cues: auto-caption cues are
 * ~7-word wrapped fragments, so a quoted sentence straddles cues and per-cue matching
 * fails outright.
 */
interface WordStream {
  words: string[];
  /** times[i] is the start time of the cue word i came from. */
  times: number[];
}

interface StretchLabel {
  about: string;
  startsHere: boolean;
  openingPhrase: string;
}

interface WorkingChapter {
  startSec: number;
  endSec: number;
  about: string;
  /** Set when stage 5 merged this span, so it gets re-summarized from its full transcript. */
  merged: boolean;
}

export class ChapterPipelineService {
  private readonly baseUrl: string;
  private readonly options: ChapterPipelineOptions;
  private readonly numCtx: number;
  private calls = 0;

  constructor(options: ChapterPipelineOptions) {
    this.options = options;
    this.numCtx = options.numCtx || DEFAULT_NUM_CTX;
    this.baseUrl = (options.host || 'http://127.0.0.1:11434').replace(/\/$/, '');
  }

  /**
   * Run the full pipeline over one video's caption segments.
   *
   * Throws rather than returning a partial chapter list: a chapter list that quietly
   * lost a boundary is unfixable by hand, and it is also the conditioning input for
   * every other metadata field, so a silent hole propagates into the title and
   * description too.
   */
  async generate(srtSegments: SRTSegment[]): Promise<ChapterPipelineResult> {
    if (!srtSegments || srtSegments.length === 0) {
      throw new Error('Chapter pipeline needs caption segments; none were supplied');
    }

    const cues = this.buildCues(srtSegments);
    const stream = this.buildWordStream(cues);
    const stretches = this.buildStretches(cues);
    const durationSeconds = cues[cues.length - 1].endSec;

    log.info(
      `[ChapterPipeline] ${formatDuration(durationSeconds)} of captions -> ${cues.length} cues, ` +
        `${stream.words.length} words, ${stretches.length} stretches of ${STRETCH_SECONDS}s`
    );

    try {
      const labels = await this.stageLabel(stretches);
      const ratings = await this.stageRate(stretches, labels);
      const selected = this.stageSelect(stretches, ratings, durationSeconds);
      const boundaries = await this.stagePlace(selected, stretches, labels, stream);
      const initial = await this.stageSummarize(boundaries, durationSeconds, cues);
      const consolidated = await this.stageConsolidate(initial, cues);

      const chapters = this.toChapters(consolidated, durationSeconds);
      return {
        chapters,
        subjects: chapters.map((c) => c.title),
        stats: {
          durationSeconds,
          stretches: stretches.length,
          junctions: ratings.length,
          boundariesSelected: selected.length,
          chaptersBeforeConsolidation: initial.length,
          chaptersAfterConsolidation: consolidated.length,
          calls: this.calls,
        },
      };
    } finally {
      await this.unloadModels();
    }
  }

  // ---------------------------------------------------------------- transcript prep

  /**
   * Cues, with auto-caption rolling-window repeats removed.
   *
   * Auto-captions repeat the previous line as they scroll. The dedupe rule is the one
   * from the sealed method: drop a line that equals the previous line, or that the
   * previous line ends with.
   */
  private buildCues(srtSegments: SRTSegment[]): Cue[] {
    const cues: Cue[] = [];
    let previous = '';
    let wordCursor = 0;

    for (const segment of srtSegments) {
      const text = (segment.text || '').trim();
      if (text.length === 0) continue;
      if (text === previous || (previous.length > 0 && previous.endsWith(text))) {
        continue;
      }
      previous = text;

      const wordCount = normalizeWords(text).length;
      if (wordCount === 0) continue;

      cues.push({
        startSec: TimeUtils.srtTimeToSeconds(segment.start),
        endSec: TimeUtils.srtTimeToSeconds(segment.end),
        text,
        wordStart: wordCursor,
        wordEnd: wordCursor + wordCount,
      });
      wordCursor += wordCount;
    }

    if (cues.length === 0) {
      throw new Error('Chapter pipeline found no usable caption text after de-duplication');
    }
    return cues;
  }

  private buildWordStream(cues: Cue[]): WordStream {
    const words: string[] = [];
    const times: number[] = [];
    for (const cue of cues) {
      for (const word of normalizeWords(cue.text)) {
        words.push(word);
        times.push(cue.startSec);
      }
    }
    return { words, times };
  }

  private buildStretches(cues: Cue[]): Stretch[] {
    const stretches: Stretch[] = [];
    let current: Cue[] = [];
    let stretchStart = cues[0].startSec;

    const flush = () => {
      if (current.length === 0) return;
      stretches.push({
        index: stretches.length,
        startSec: current[0].startSec,
        endSec: current[current.length - 1].endSec,
        text: current.map((c) => c.text).join(' '),
        wordStart: current[0].wordStart,
        wordEnd: current[current.length - 1].wordEnd,
      });
      current = [];
    };

    for (const cue of cues) {
      if (current.length > 0 && cue.startSec - stretchStart >= STRETCH_SECONDS) {
        flush();
        stretchStart = cue.startSec;
      }
      current.push(cue);
    }
    flush();

    return stretches;
  }

  /** Raw transcript text between two times, for the summarize stages. */
  private transcriptBetween(cues: Cue[], startSec: number, endSec: number): string {
    return cues
      .filter((c) => c.startSec >= startSec && c.startSec < endSec)
      .map((c) => c.text)
      .join(' ');
  }

  // ------------------------------------------------------------- quote -> timestamp

  /**
   * Measure where a quoted sentence starts, searching only the word range it was
   * quoted from. Exact match on the first 12 words; otherwise the best positional
   * match, which must clear 0.5 to count.
   */
  private mapQuote(
    quote: string,
    stream: WordStream,
    fromIndex: number,
    toIndex: number
  ): number | null {
    const quoteWords = normalizeWords(quote);
    if (quoteWords.length === 0) return null;

    const probe = quoteWords.slice(0, QUOTE_PROBE_WORDS);
    const last = Math.min(toIndex, stream.words.length) - probe.length;

    for (let i = Math.max(0, fromIndex); i <= last; i++) {
      let hit = true;
      for (let k = 0; k < probe.length; k++) {
        if (stream.words[i + k] !== probe[k]) {
          hit = false;
          break;
        }
      }
      if (hit) return stream.times[i];
    }

    let bestScore = 0;
    let bestIndex = -1;
    for (let i = Math.max(0, fromIndex); i <= last; i++) {
      let matches = 0;
      for (let k = 0; k < probe.length; k++) {
        if (stream.words[i + k] === probe[k]) matches++;
      }
      const score = matches / probe.length;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    if (bestIndex !== -1 && bestScore >= QUOTE_MATCH_THRESHOLD) {
      return stream.times[bestIndex];
    }
    return null;
  }

  // -------------------------------------------------------------------- model calls

  private modelFor(stage: ChapterStage): string {
    return this.options.stageModels?.[stage] || this.options.model;
  }

  private checkCancelled(): void {
    if (this.options.cancelCallback?.()) {
      throw new Error('Chapter generation cancelled by user');
    }
  }

  private async call(stage: ChapterStage, prompt: string, what: string): Promise<any> {
    this.checkCancelled();
    const model = this.modelFor(stage);
    this.calls++;

    let data: any;
    try {
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          format: 'json',
          keep_alive: KEEP_ALIVE,
          options: {
            temperature: 0,
            num_ctx: this.numCtx,
            num_predict: NUM_PREDICT,
          },
        }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        if (response.status === 404) {
          throw new Error(
            `Chapter stage "${stage}" needs Ollama model "${model}", which is not installed. Pull it with: ollama pull ${model}`
          );
        }
        throw new Error(
          `Chapter stage "${stage}" failed on ${what} (model ${model}): HTTP ${response.status} ${body.slice(0, 300)}`
        );
      }

      data = await response.json();
    } catch (error: any) {
      // Already shaped by the !response.ok branch above — don't re-wrap and lose the
      // "pull it with" instruction.
      if (error instanceof Error && error.message.startsWith(`Chapter stage "${stage}"`)) {
        throw error;
      }
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new Error(
          `Chapter stage "${stage}" timed out after ${CALL_TIMEOUT_MS / 1000}s on ${what} (model ${model})`
        );
      }
      const detail = error?.message || 'unknown error';
      throw new Error(`Chapter stage "${stage}" failed on ${what} (model ${model}): ${detail}`);
    }

    if (data?.done_reason === 'length') {
      throw new Error(
        `Chapter stage "${stage}" hit the ${NUM_PREDICT}-token output limit on ${what}, so its JSON is truncated`
      );
    }

    const raw = data?.response;
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new Error(`Chapter stage "${stage}" returned an empty response on ${what}`);
    }

    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(
        `Chapter stage "${stage}" returned unparseable JSON on ${what}: ${raw.slice(0, 200)}`
      );
    }
  }

  /**
   * Release the resident model(s). Purely housekeeping — a failure here costs VRAM
   * until Ollama's own timer fires, so it warns rather than failing a finished run.
   */
  private async unloadModels(): Promise<void> {
    const models = new Set<string>([this.options.model, ...Object.values(this.options.stageModels || {})]);
    for (const model of models) {
      if (!model) continue;
      try {
        await fetch(`${this.baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, prompt: '', keep_alive: 0 }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error: any) {
        console.warn(`[ChapterPipeline] Could not unload "${model}": ${error?.message || error}`);
      }
    }
  }

  private requireString(value: unknown, field: string, stage: ChapterStage, what: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`Chapter stage "${stage}" returned no usable "${field}" on ${what}`);
    }
    return value.trim();
  }

  // ------------------------------------------------------------------------ stage 1

  /** One call per 45s stretch. These labels are scaffolding for stage 2, not chapter names. */
  private async stageLabel(stretches: Stretch[]): Promise<StretchLabel[]> {
    const labels: StretchLabel[] = [];

    for (const stretch of stretches) {
      const what = `stretch ${stretch.index + 1}/${stretches.length} at ${TimeUtils.secondsToYoutubeTime(stretch.startSec)}`;
      const parsed = await this.call(
        'label',
        formatPrompt(CHAPTER_PROMPTS.LABEL, { segment: stretch.text }),
        what
      );

      const about = this.requireString(parsed?.about, 'about', 'label', what);
      // starts_here / opening_phrase shape the model's answer and are logged for
      // debugging, but no later stage reads them: stage 3b re-derives placement
      // independently against a window it can actually see.
      const startsHere = parsed?.starts_here === true || parsed?.starts_here === 'true';
      const openingPhrase = typeof parsed?.opening_phrase === 'string' ? parsed.opening_phrase : '';

      labels.push({ about, startsHere, openingPhrase });
      this.options.onProgress?.('label', labels.length, stretches.length);
    }

    return labels;
  }

  // ------------------------------------------------------------------------ stage 2

  /**
   * One call per junction. Individually these ratings look weak (AUC ~0.55 against
   * reference boundaries) — do NOT threshold them. Ranking by them doubles end-to-end
   * F1 versus not ranking, which is what stage 3 does.
   */
  private async stageRate(stretches: Stretch[], labels: StretchLabel[]): Promise<number[]> {
    const ratings: number[] = [];

    for (let j = 0; j < stretches.length - 1; j++) {
      const what = `junction ${j + 1}/${stretches.length - 1} at ${TimeUtils.secondsToYoutubeTime(stretches[j + 1].startSec)}`;
      const parsed = await this.call(
        'rate',
        formatPrompt(CHAPTER_PROMPTS.RATE_JUNCTION, {
          before: labels[j].about,
          after: labels[j + 1].about,
          window: `${stretches[j].text} ${stretches[j + 1].text}`,
        }),
        what
      );

      const change = Number(parsed?.change);
      if (!Number.isInteger(change) || change < 0 || change > 3) {
        throw new Error(
          `Chapter stage "rate" returned "${parsed?.change}" for ${what}; expected an integer 0-3`
        );
      }

      ratings.push(change);
      this.options.onProgress?.('rate', ratings.length, stretches.length - 1);
    }

    return ratings;
  }

  // ------------------------------------------------------------------------ stage 3

  /**
   * Select boundaries — zero model calls. Rank by change, take strongest-first while
   * enforcing minimum spacing, break ties farthest-from-already-chosen. 0:00 is always
   * a chapter and is never scored, but it does anchor the spacing.
   *
   * The count deliberately OVER-segments: stage 5 consolidates back down. Over-splits
   * the user fixes by joining in one click; under-splits nobody can fix by hand.
   */
  private stageSelect(stretches: Stretch[], ratings: number[], durationSeconds: number): number[] {
    const target = targetSecondsFor(durationSeconds);
    const wanted = Math.max(MIN_CHAPTERS, Math.round(durationSeconds / target)) - 1;
    const minGap = 0.6 * target;

    const remaining = ratings.map((change, junction) => ({
      junction,
      change,
      time: stretches[junction + 1].startSec,
    }));

    const chosen: number[] = [];
    const chosenTimes: number[] = [0]; // 0:00 anchors spacing without being scored

    while (chosen.length < wanted) {
      let best: { junction: number; change: number; time: number; distance: number } | null = null;

      for (const candidate of remaining) {
        if (chosen.includes(candidate.junction)) continue;
        const distance = Math.min(...chosenTimes.map((t) => Math.abs(candidate.time - t)));
        if (distance < minGap) continue;
        if (
          !best ||
          candidate.change > best.change ||
          (candidate.change === best.change && distance > best.distance)
        ) {
          best = { ...candidate, distance };
        }
      }

      if (!best) break; // spacing exhausted the candidates before the target count
      chosen.push(best.junction);
      chosenTimes.push(best.time);
    }

    chosen.sort((a, b) => a - b);
    log.info(
      `[ChapterPipeline] Selected ${chosen.length}/${wanted} boundaries ` +
        `(target ${Math.round(target)}s per chapter, min gap ${Math.round(minGap)}s)`
    );
    return chosen;
  }

  // ----------------------------------------------------------------------- stage 3b

  /**
   * Place each selected boundary to the second. A junction is only accurate to +/-45s,
   * so one call reads the two stretches around it and quotes the sentence where the
   * host TURNS to the new subject; mapQuote() measures where that lands.
   *
   * Consecutive selections are always >= 2 stretches apart (min gap 0.6 x target, and
   * the smallest target is 132s), so these windows never overlap and the placements
   * come out ordered.
   */
  private async stagePlace(
    selected: number[],
    stretches: Stretch[],
    labels: StretchLabel[],
    stream: WordStream
  ): Promise<number[]> {
    const placed: number[] = [];

    for (const junction of selected) {
      const before = stretches[junction];
      const after = stretches[junction + 1];
      const what = `boundary near ${TimeUtils.secondsToYoutubeTime(after.startSec)}`;

      const parsed = await this.call(
        'place',
        formatPrompt(CHAPTER_PROMPTS.PLACE_BOUNDARY, {
          before: labels[junction].about,
          after: labels[junction + 1].about,
          window: `${before.text} ${after.text}`,
        }),
        what
      );

      const quote = this.requireString(parsed?.start_phrase, 'start_phrase', 'place', what);
      const seconds = this.mapQuote(quote, stream, before.wordStart, after.wordEnd);

      if (seconds === null) {
        throw new Error(
          `Chapter boundary at ${TimeUtils.secondsToYoutubeTime(after.startSec)} could not be placed: ` +
            `the model's quote does not appear in the transcript between ` +
            `${TimeUtils.secondsToYoutubeTime(before.startSec)} and ${TimeUtils.secondsToYoutubeTime(after.endSec)}. ` +
            `Quote was: "${quote}"`
        );
      }

      const previous = placed.length > 0 ? placed[placed.length - 1] : 0;
      if (seconds <= previous) {
        throw new Error(
          `Chapter boundaries came out of order: ${TimeUtils.secondsToYoutubeTime(seconds)} does not follow ` +
            `${TimeUtils.secondsToYoutubeTime(previous)} (quote: "${quote}")`
        );
      }

      placed.push(seconds);
      this.options.onProgress?.('place', placed.length, selected.length);
    }

    return placed;
  }

  // ------------------------------------------------------------------------ stage 4

  /**
   * Summarize each chapter's ACTUAL transcript span. These are the real chapter names
   * and the subject list the downstream fields condition on.
   */
  private async stageSummarize(
    boundaries: number[],
    durationSeconds: number,
    cues: Cue[]
  ): Promise<WorkingChapter[]> {
    const starts = [0, ...boundaries];
    const chapters: WorkingChapter[] = [];

    for (let i = 0; i < starts.length; i++) {
      const startSec = starts[i];
      const endSec = i < starts.length - 1 ? starts[i + 1] : durationSeconds;
      chapters.push({
        startSec,
        endSec,
        about: await this.summarizeSpan(startSec, endSec, cues, `chapter ${i + 1}/${starts.length}`),
        merged: false,
      });
      this.options.onProgress?.('summarize', chapters.length, starts.length);
    }

    return chapters;
  }

  /**
   * One summarize call for one span.
   *
   * REFUSES rather than truncating when the span will not fit the context window: a
   * summary of a chapter's opening teaches nothing about the chapter, and it would go
   * on to mislead every downstream field too.
   */
  private async summarizeSpan(
    startSec: number,
    endSec: number,
    cues: Cue[],
    what: string
  ): Promise<string> {
    const transcript = this.transcriptBetween(cues, startSec, endSec);
    if (transcript.trim().length === 0) {
      throw new Error(
        `Chapter span ${TimeUtils.secondsToYoutubeTime(startSec)}-${TimeUtils.secondsToYoutubeTime(endSec)} has no transcript text`
      );
    }

    const wordCount = normalizeWords(transcript).length;
    const estimatedTokens = Math.ceil(wordCount * 1.4 + 600);
    if (estimatedTokens > this.numCtx) {
      throw new Error(
        `Chapter span ${TimeUtils.secondsToYoutubeTime(startSec)}-${TimeUtils.secondsToYoutubeTime(endSec)} ` +
          `needs about ${estimatedTokens} tokens but num_ctx is ${this.numCtx}. ` +
          `Raise the chapter context window to at least ${estimatedTokens} and re-run.`
      );
    }

    const parsed = await this.call(
      'summarize',
      formatPrompt(CHAPTER_PROMPTS.SUMMARIZE_CHAPTER, {
        start: TimeUtils.secondsToYoutubeTime(startSec),
        end: TimeUtils.secondsToYoutubeTime(endSec),
        transcript,
      }),
      what
    );

    return this.requireString(parsed?.about, 'about', 'summarize', what);
  }

  // ------------------------------------------------------------------------ stage 5

  /**
   * Consolidate. Walk left to right asking "one story or two?" about EVERY adjacent
   * pair — a gated version (only short-sided or weak-junction pairs eligible) merged 1
   * of the 8 pairs that needed merging on the livestream test.
   *
   * Merges apply immediately and the cursor stays put, so a story split three ways
   * collapses in one sweep. Merged spans keep chapter A's summary DURING the sweep and
   * are re-summarized from their full transcript afterwards.
   */
  private async stageConsolidate(initial: WorkingChapter[], cues: Cue[]): Promise<WorkingChapter[]> {
    const chapters = initial.map((c) => ({ ...c }));
    let i = 0;
    let comparisons = 0;
    const totalPairs = Math.max(1, chapters.length - 1);

    while (i < chapters.length - 1 && chapters.length > MIN_CHAPTERS) {
      const a = chapters[i];
      const b = chapters[i + 1];
      const what = `pair ${i + 1} (${TimeUtils.secondsToYoutubeTime(a.startSec)} + ${TimeUtils.secondsToYoutubeTime(b.startSec)})`;

      const parsed = await this.call(
        'consolidate',
        formatPrompt(CHAPTER_PROMPTS.CONSOLIDATE_PAIR, {
          a_length: formatDuration(a.endSec - a.startSec),
          a_about: a.about,
          b_length: formatDuration(b.endSec - b.startSec),
          b_about: b.about,
        }),
        what
      );

      if (typeof parsed?.one_story !== 'boolean' && parsed?.one_story !== 'true' && parsed?.one_story !== 'false') {
        throw new Error(
          `Chapter stage "consolidate" returned "${parsed?.one_story}" for ${what}; expected true or false`
        );
      }
      const oneStory = parsed.one_story === true || parsed.one_story === 'true';

      comparisons++;
      this.options.onProgress?.('consolidate', Math.min(comparisons, totalPairs), totalPairs);

      if (oneStory) {
        log.info(`[ChapterPipeline] Merging ${what}: "${a.about}" + "${b.about}" (${parsed?.why || 'no reason given'})`);
        chapters.splice(i, 2, { startSec: a.startSec, endSec: b.endSec, about: a.about, merged: true });
        // Cursor stays at i so the merged span is compared to what follows.
      } else {
        i++;
      }
    }

    // Re-summarize every merged span from its full transcript — chapter A's summary
    // described only the first slice of what is now one chapter.
    for (let k = 0; k < chapters.length; k++) {
      if (!chapters[k].merged) continue;
      chapters[k].about = await this.summarizeSpan(
        chapters[k].startSec,
        chapters[k].endSec,
        cues,
        `merged chapter ${k + 1}/${chapters.length}`
      );
    }

    log.info(`[ChapterPipeline] Consolidated ${initial.length} chapters -> ${chapters.length}`);
    return chapters;
  }

  // ---------------------------------------------------------------------- assembling

  private toChapters(working: WorkingChapter[], durationSeconds: number): Chapter[] {
    return working.map((chapter, index) => ({
      timestamp: TimeUtils.secondsToYoutubeTime(chapter.startSec),
      title: chapter.about,
      sequence: index,
      endTimestamp: TimeUtils.secondsToYoutubeTime(
        index < working.length - 1 ? working[index + 1].startSec : durationSeconds
      ),
    }));
  }
}
