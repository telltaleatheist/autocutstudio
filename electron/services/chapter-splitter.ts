// electron/services/chapter-splitter.ts
//
// Chapter/subject detection for Story Mode, ported from the two-pass, time-windowed segmenter in
// the sibling "Briefcase" app. The design is built for long transcripts and weaker local models:
//
//   Pass 1 (boundary detection) — the transcript is sliced into CONTIGUOUS, NON-OVERLAPPING time
//     windows sized to the model (a 3B model gets 3-minute windows; a 32B+ gets 20). Each window
//     asks only "where does the subject change here?" and returns verbatim boundary PHRASES plus an
//     `end_topic`. The end_topic is threaded into the next window's prompt so continuity survives
//     the seam WITHOUT overlapping text. Each phrase is mapped back to a timestamp by fuzzy
//     matching against that window's segments, then merged into one global, deduped boundary list
//     seeded at 0 (chapter 1 always starts at the span start).
//
//   Titles — one consolidated call names every chapter from a short snippet, so titles never
//     fragment a subject across a window seam.
//
// Chapters are the spans between sorted boundaries — gap-free and duplicate-free by construction,
// covering 0 → the span end regardless of how coarse or fine the model is.
import * as log from 'electron-log';

export interface Segment {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

export interface Chapter {
  index: number;
  startSeconds: number;
  endSeconds: number;
  label: string;
  verbalCue: boolean;
}

/** LLM call. `opts` lets a caller tune the per-call output budget (num_predict). */
export type Generate = (prompt: string, opts?: { numPredict?: number; temperature?: number }) => Promise<string>;

const MIN_GAP_SECONDS = 45;      // collapse near-duplicate boundaries (incl. across window seams)
const MAX_WINDOW_CHARS = 30000;  // safety cap on a window's text (~10k tokens); windows rarely hit it
const SNIPPET_CHARS = 500;       // per-chapter text sent to the titling call

// ── time formatting ──────────────────────────────────────────────────────────
function secondsToClock(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function durationPhrase(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return h > 0 ? `${h} hour${h > 1 ? 's' : ''} ${m} minutes` : `${m} minutes`;
}

// ── window sizing (by model parameter count) ─────────────────────────────────
/** Minutes of transcript per Pass-1 window, tiered by the model's parameter count parsed from its
 *  name (e.g. "cogito:14b" → 14). Bigger models reliably hold more context, so they get wider
 *  windows (fewer calls); a 3B needs short windows to segment well. */
function windowMinutesForModel(model: string): number {
  const m = (model || '').toLowerCase().match(/(\d+(?:\.\d+)?)\s*b/);
  const b = m ? parseFloat(m[1]) : 7;
  if (b <= 3) return 3;
  if (b <= 7) return 7;
  if (b <= 14) return 12;
  if (b <= 32) return 15;
  return 20;
}

interface Window { startTime: number; endTime: number; segments: Segment[]; text: string; }

/** Slice segments into contiguous, non-overlapping wall-clock windows of `minutes` each. */
function chunkByTime(segments: Segment[], minutes: number): Window[] {
  const chunkDuration = minutes * 60;
  const total = segments.reduce((mx, s) => Math.max(mx, s.endSeconds), 0);
  const windows: Window[] = [];
  let start = 0;
  while (start < total) {
    const end = start + chunkDuration;
    const segs = segments.filter(s => s.startSeconds >= start && s.startSeconds < end);
    if (segs.length > 0) {
      windows.push({
        startTime: start,
        endTime: Math.min(end, total),
        segments: segs,
        text: segs.map(s => s.text.trim()).join(' '),
      });
    }
    start = end;
  }
  return windows;
}

// ── phrase → timestamp matching (5 strategies) ───────────────────────────────
function normalizeForComparison(text: string): string {
  return text.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

function levenshteinDistance(str1: string, str2: string): number {
  const m = str1.length;
  const n = str2.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) dp[i][j] = dp[i - 1][j - 1];
      else dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function stringSimilarity(str1: string, str2: string): number {
  if (str1.length === 0 && str2.length === 0) return 1;
  if (str1.length === 0 || str2.length === 0) return 0;
  return 1 - levenshteinDistance(str1, str2) / Math.max(str1.length, str2.length);
}

const COMMON_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need',
  'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their',
  'we', 'us', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her',
  'i', 'me', 'my', 'so', 'if', 'then', 'than', 'as', 'just', 'also',
  'like', 'well', 'now', 'here', 'there', 'when', 'where', 'what', 'who',
  'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
  'some', 'such', 'no', 'not', 'only', 'own', 'same', 'very', 'just',
  'about', 'into', 'over', 'after', 'before', 'between', 'under', 'again',
  'going', 'know', 'think', 'right', 'really', 'actually', 'gonna', 'yeah',
]);

/** Find the segment start time (seconds) where a quoted phrase occurs, searching WITHIN the given
 *  segments (a window's). 5 strategies: direct substring → shorter prefix → Levenshtein fuzzy →
 *  distinctive-word → cross-segment. Returns null when nothing matches. */
function findPhraseTimestamp(phrase: string, segments: Segment[]): number | null {
  if (!phrase || !segments || segments.length === 0) return null;
  const normalizedPhrase = normalizeForComparison(phrase);
  if (normalizedPhrase.length === 0) return null;

  interface Entry { normalizedText: string; timestamp: number; }
  const entries: Entry[] = [];
  for (const seg of segments) {
    const text = (seg.text || '').trim();
    if (text.length > 0) entries.push({ normalizedText: normalizeForComparison(text), timestamp: seg.startSeconds });
  }
  if (entries.length === 0) return null;

  const searchPhrase = normalizedPhrase.substring(0, 50);

  for (const seg of entries) if (seg.normalizedText.includes(searchPhrase)) return seg.timestamp;

  if (searchPhrase.length > 25) {
    const shortPhrase = normalizedPhrase.substring(0, 25);
    for (const seg of entries) if (seg.normalizedText.includes(shortPhrase)) return seg.timestamp;
  }

  const FUZZY_THRESHOLD = 0.65;
  let bestFuzzy: { timestamp: number; score: number } | null = null;
  for (const seg of entries) {
    const compareText = seg.normalizedText.substring(0, searchPhrase.length + 10);
    const similarity = stringSimilarity(searchPhrase, compareText);
    if (similarity > FUZZY_THRESHOLD && (!bestFuzzy || similarity > bestFuzzy.score)) {
      bestFuzzy = { timestamp: seg.timestamp, score: similarity };
    }
  }
  if (bestFuzzy) return bestFuzzy.timestamp;

  const phraseWords = normalizedPhrase.split(/\s+/).filter(w => w.length > 2 && !COMMON_WORDS.has(w));
  if (phraseWords.length > 0) {
    let bestMatch: { timestamp: number; score: number } | null = null;
    for (const seg of entries) {
      const segWords = seg.normalizedText.split(/\s+/);
      let matchCount = 0;
      for (const phraseWord of phraseWords) {
        if (segWords.includes(phraseWord)) { matchCount++; continue; }
        for (const segWord of segWords) {
          if (stringSimilarity(phraseWord, segWord) > 0.75) { matchCount += 0.75; break; }
        }
      }
      const score = matchCount / phraseWords.length;
      if (score > 0.4 && (!bestMatch || score > bestMatch.score)) bestMatch = { timestamp: seg.timestamp, score };
    }
    if (bestMatch) return bestMatch.timestamp;
  }

  for (let i = 0; i < entries.length - 1; i++) {
    const combined = entries[i].normalizedText + ' ' + entries[i + 1].normalizedText;
    if (combined.includes(searchPhrase)) return entries[i].timestamp;
    const compareText = combined.substring(0, searchPhrase.length + 20);
    if (stringSimilarity(searchPhrase, compareText) > FUZZY_THRESHOLD) return entries[i].timestamp;
  }
  return null;
}

// ── Pass 1: boundary detection ───────────────────────────────────────────────
function buildBoundaryPrompt(windowText: string, previousTopic: string, isFirst: boolean, totalSeconds: number): string {
  const prev = previousTopic ? `Prior section ended on: "${previousTopic}"\n` : '';
  const firstLine = isFirst
    ? '- Do NOT mark the very first words — chapter 1 already starts at the beginning.\n'
    : '';
  return `Find where the SUBJECT changes in this transcript excerpt. Output JSON only.
Total recording duration: ${durationPhrase(totalSeconds)}
${prev}A boundary is where the speaker turns to a clearly DIFFERENT subject — not a new example, tangent, or another angle on the same subject. In this kind of content a genuine shift is occasional, not every minute.
- Copy the exact 4-8 word phrase from the transcript where the new subject begins.
${firstLine}- Also note, in a few words, what the transcript is discussing at its END.

Output exactly this shape and nothing else:
{"boundaries": ["exact phrase where the next subject begins"], "end_topic": "what it is discussing at the end"}

If the subject never changes in this excerpt, output: {"boundaries": [], "end_topic": "..."}

Transcript:
${windowText}`;
}

interface BoundaryResult { boundaries: string[]; end_topic: string; }

function parseBoundaryResponse(response: string): BoundaryResult | null {
  const match = response.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Partial<BoundaryResult>;
    const boundaries = Array.isArray(parsed.boundaries) ? parsed.boundaries.filter(b => typeof b === 'string') : [];
    return { boundaries, end_topic: typeof parsed.end_topic === 'string' ? parsed.end_topic : '' };
  } catch {
    // Recover phrase strings from a "boundaries": [...] array even if the rest is malformed.
    const arr = match[0].match(/"boundaries"\s*:\s*\[([\s\S]*?)\]/);
    if (arr) {
      const phrases = [...arr[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
      const topic = match[0].match(/"end_topic"\s*:\s*"([^"]*)"/);
      return { boundaries: phrases, end_topic: topic ? topic[1] : '' };
    }
    return null;
  }
}

// ── titles: one consolidated call ────────────────────────────────────────────
function buildTitlesPrompt(items: { n: number; snippet: string }[]): string {
  const list = items.map(it => `Chapter ${it.n}:\n${it.snippet}`).join('\n\n');
  return `Give each chapter a short, specific subject title (4-8 words). Do not prepend "Chapter". Output JSON only.

Output exactly this shape and nothing else:
{"titles": {"1": "title for chapter 1", "2": "title for chapter 2"}}

${list}`;
}

function parseTitlesResponse(response: string): Record<string, string> {
  const match = response.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try {
    const parsed = JSON.parse(match[0]) as { titles?: Record<string, unknown> };
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed.titles || {})) if (typeof v === 'string') out[k] = v.trim();
    return out;
  } catch {
    return {};
  }
}

/** Text of the segments in [start, end), truncated — enough to name the chapter. */
function snippetForRange(segments: Segment[], start: number, end: number): string {
  const text = segments
    .filter(s => s.startSeconds >= start - 0.001 && s.startSeconds < end)
    .map(s => s.text.trim())
    .join(' ')
    .trim();
  return text.length > SNIPPET_CHARS ? text.slice(0, SNIPPET_CHARS) : text;
}

/** Cheap fallback label from a snippet's first words. */
function deriveLabel(snippet: string): string {
  const words = snippet.split(/\s+/).slice(0, 8).join(' ').replace(/[.,;:]+$/, '');
  return words || 'Untitled';
}

/**
 * Split a span of transcript into consecutive subject chapters via windowed boundary detection.
 * `segments` carry ABSOLUTE original-timeline seconds; internally the span is rebased to 0 so
 * window slicing and phrase matching are 0-based, then chapter seconds are shifted back to absolute.
 */
export async function analyzeChapters(segments: Segment[], model: string, generate: Generate): Promise<Chapter[]> {
  if (!segments || segments.length === 0) throw new Error('No transcript in this span to analyze.');

  const spanStart = segments.reduce((mn, s) => Math.min(mn, s.startSeconds), Infinity);
  const spanEnd = segments.reduce((mx, s) => Math.max(mx, s.endSeconds), 0);
  const spanDuration = Math.max(0, spanEnd - spanStart);

  const rel: Segment[] = segments
    .map(s => ({ text: s.text, startSeconds: s.startSeconds - spanStart, endSeconds: s.endSeconds - spanStart }))
    .sort((a, b) => a.startSeconds - b.startSeconds);

  const windowMinutes = windowMinutesForModel(model);
  const windows = chunkByTime(rel, windowMinutes);
  log.info(
    `[ChapterSplitter] span ${secondsToClock(spanStart)}..${secondsToClock(spanEnd)} ` +
    `(${(spanDuration / 60).toFixed(1)} min) · ${segments.length} segments · ` +
    `model=${model} → ${windows.length} windows of ${windowMinutes} min`
  );

  // Pass 1 — boundary phrases per window, merged into one deduped, 0-seeded list.
  const boundaries: number[] = [0];
  let previousTopic = '';
  let windowSuccesses = 0;
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    const prompt = buildBoundaryPrompt(w.text.slice(0, MAX_WINDOW_CHARS), previousTopic, i === 0, spanDuration);
    let result: BoundaryResult | null = null;
    for (let attempt = 0; attempt <= 1 && !result; attempt++) {
      try {
        const resp = await generate(prompt, { numPredict: 512 });
        result = parseBoundaryResponse(resp);
      } catch (err) {
        log.warn(`[ChapterSplitter] window ${i + 1}/${windows.length} attempt ${attempt + 1} failed: ${(err as Error)?.message}`);
      }
    }
    if (!result) {
      log.warn(`[ChapterSplitter] window ${i + 1}/${windows.length} produced no parseable boundaries`);
      continue;
    }
    windowSuccesses++;
    for (const phrase of result.boundaries) {
      const t = findPhraseTimestamp(phrase, w.segments);
      if (t !== null && !boundaries.some(b => Math.abs(b - t) < MIN_GAP_SECONDS)) boundaries.push(t);
    }
    previousTopic = result.end_topic || previousTopic;
  }

  if (windows.length > 0 && windowSuccesses === 0) {
    throw new Error('The model produced no parseable output for any window. Try a different model.');
  }
  boundaries.sort((a, b) => a - b);
  log.info(`[ChapterSplitter] ${boundaries.length} boundaries across ${windowSuccesses}/${windows.length} windows`);

  // Chapters = spans between sorted boundaries (last → span end). Gap-free by construction.
  const spans = boundaries.map((b, i) => ({
    startRel: b,
    endRel: i < boundaries.length - 1 ? boundaries[i + 1] : spanDuration,
  }));

  // Titles — one call names them all (handles chapter 1; never fragments a subject across seams).
  const items = spans.map((sp, i) => ({ n: i + 1, snippet: snippetForRange(rel, sp.startRel, sp.endRel) }));
  let titles: Record<string, string> = {};
  try {
    const resp = await generate(buildTitlesPrompt(items), { numPredict: 2048 });
    titles = parseTitlesResponse(resp);
  } catch (err) {
    log.warn(`[ChapterSplitter] titling call failed, using derived labels: ${(err as Error)?.message}`);
  }

  return spans.map((sp, i) => ({
    index: i + 1,
    startSeconds: sp.startRel + spanStart,
    endSeconds: sp.endRel + spanStart,
    label: titles[String(i + 1)] || deriveLabel(items[i].snippet),
    verbalCue: false,
  }));
}

// ── title suggestion (single story → one title) ──────────────────────────────
//
// A focused, single-title adaptation of ContentStudio's title guidance (front-load the subject,
// plain language over euphemism, concrete and specific, punchy). Returns ONE strong title for
// auto-filling a story label.
function buildTitlePrompt(transcriptText: string): string {
  const MAX = 12000;
  const body = transcriptText.length > MAX
    ? transcriptText.slice(0, MAX / 2) + '\n…\n' + transcriptText.slice(-MAX / 2)
    : transcriptText;
  return `You are titling a video segment for an editor's story list. Read the transcript below and write ONE concise, specific title for it.

Rules:
- Front-load the subject in the first few words. Name who or what it is about.
- Plain language over euphemism — say what actually happens.
- Concrete and specific to THIS segment, not generic. Anchor to a real moment, claim, or name from the transcript.
- 40-70 characters. No trailing punctuation. No surrounding quotes.

Return ONLY valid JSON, nothing else:
{ "title": "the title" }

Transcript:
${body}`;
}

/** Generate a single suggested title for a story's transcript text. Throws on failure. */
export async function suggestTitle(transcriptText: string, generate: Generate): Promise<string> {
  const text = (transcriptText || '').trim();
  if (!text) throw new Error('This story has no transcript text to title.');

  const response = await generate(buildTitlePrompt(text), { numPredict: 256 });
  const match = response.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as { title?: string };
      const title = (parsed.title || '').trim().replace(/^["']|["']$/g, '');
      if (title) return title;
    } catch {
      // fall through to line recovery
    }
  }
  const line = response
    .split('\n')
    .map(l => l.trim())
    .find(l => l && !l.startsWith('```') && !l.startsWith('{'));
  if (line) return line.replace(/^["']|["']$/g, '').slice(0, 120);
  throw new Error('The model did not return a usable title.');
}
