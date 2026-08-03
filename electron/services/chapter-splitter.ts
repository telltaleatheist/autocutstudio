// electron/services/chapter-splitter.ts
//
// Chapter detection for Story Mode — the SEALED local-14B method (sealed 2026-08-02, validated
// against a 2:10:46 livestream graded on the creator's own 7-story list). It replaces the older
// windowed "find the boundaries in this 12-minute chunk" segmenter, which failed for the reason
// this whole design exists:
//
//   A 14B cannot select K items from a list of N. Ask it which boundaries in a long stretch are
//   real and it returns a prefix — the first few — and stops.
//
// So the one law here is absolute:
//
//   NO model call ever sees a list, a count, or the whole video. Every call asks ONE local
//   question about ONE thing. Code does all counting, ranking, spacing and assembling.
//
// Corollaries, each learned the hard way and each load-bearing:
//   • The model NEVER emits a timestamp. It quotes a verbatim sentence; code maps the quote to a
//     time against the flattened word stream. An invented timestamp is a guess; a mapped quote is
//     a measurement.
//   • temperature 0 and format:json on every call. At temp > 0 a single-video result is not a
//     measurement (the same config scored 0.50 then 0.00 on consecutive runs).
//   • Prompt examples use invented, neutral-domain names. Real names in an example LEAK into
//     outputs deterministically at temp 0.
//   • Ratings are RANKED, never thresholded. Individually the junction ratings are weak
//     (AUC ~0.55); ranking by them doubles end-to-end F1 versus not ranking.
//
// The pipeline — no stage sees the whole video; a 3-hour stream and a 12-minute upload run
// identical logic and differ only in the number of calls:
//
//   1  label       one call per 45 s stretch  → 3-6 word subject (scaffolding for stage 2, NOT
//                                                the chapter names)
//   2  rate        one call per junction      → 0-3 subject-change score
//   3  select      ZERO model calls           → duration-derived count, rank by score, min-gap
//   3b place       one call per boundary      → verbatim quote of the turn → mapped to a second
//   4  summarize   one call per chapter       → the real 4-8 word chapter names
//   5  consolidate one call per adjacent pair → "one story or two?", merges applied immediately
//
// Stage 3 deliberately OVER-segments (a 2 h stream gets ~21 boundaries for ~7 real stories) and
// stage 5 collapses the splits. That asymmetry is on purpose: an over-split is fixed by the user
// in one click (join), an under-split — a boundary that was never found — cannot be fixed by hand
// at all.
//
// The full method, its validation numbers and its open limitations: docs/chaptering-method.md.
// Reference implementation: chapter_harness.py + chapter_prompts/ in the orpheus-voice-finetune
// repo. The prompt bodies below are copied from there VERBATIM — they are tested artifacts, not
// suggestions. Do not "tidy" their wording.
import * as log from 'electron-log';

export interface Segment {
  text: string;
  startSeconds: number;
  endSeconds: number;
  /**
   * Which side of the commentary this segment is: the host's own mic, or the footage being
   * reacted to. Stage 4 renders its transcript with HOST:/CLIP: line tags built from this,
   * because without them the model cannot tell the host's verdict from the footage's claim —
   * audition3 (2026-08-03, scratchpad audition3*.js) showed it inverting attribution on a real
   * chapter ("racist flight attendant" where the host is calling the PASSENGER racist).
   * Stages 1-3 never see the tags; their sealed prompts read the bare text.
   */
  speaker: 'host' | 'clip';
}

/**
 * One PRE-consolidation chapter — the fine tier, as stage 4 named it from its own transcript span.
 *
 * Stage 5 merges chapters into stories, and this is what each story was built from. Retained rather
 * than discarded because it is exactly what a YouTube description's chapter markers need, and what
 * a title model conditions on — and because it costs nothing to keep: every one of these was
 * already computed and named before consolidation ran.
 */
export interface SubChapter {
  startSeconds: number;
  endSeconds: number;
  label: string;
  /**
   * One or two description-grade sentences about this chapter — names, claims, outcomes, the
   * host's framing. Written by the same stage-4 call as `label`. This is what the titling model
   * is fed (it was trained on real video DESCRIPTIONS, 60–2200 chars of prose — 4-8 word labels
   * sit far below that distribution and starve it of specifics). Empty string when stage 4
   * fell back to a derived label.
   */
  detail: string;
  /**
   * This start is a raw junction, not a mapped quote — accurate to ±45 s rather than the ~5 s the
   * method targets, because no quote for it could be located in the word stream.
   *
   * Carried on the chapter rather than left in a log because the failure is invisible in the
   * output: a description built from these reads exactly like one built from mapped quotes, and
   * the only symptom is a viewer clicking a marker and landing half a minute off. Consumers should
   * show it. Absent = placed from a quote.
   */
  startApprox?: boolean;
}

export interface Chapter {
  index: number;
  startSeconds: number;
  endSeconds: number;
  label: string;
  /** Description-grade sentences for this chapter — see SubChapter.detail. */
  detail: string;
  verbalCue: boolean;
  /** Start placed from a raw ±45 s junction rather than a mapped quote — see SubChapter. */
  startApprox?: boolean;
  /**
   * The chapters this one was consolidated from, in time order, tiling it exactly. A chapter that
   * was never merged has a single entry equal to itself — accurate, but nothing a description can
   * use, so consumers should treat "length 1" as "no internal chapters".
   */
  subChapters: SubChapter[];
}

/** LLM call. `json` requests Ollama's `format: "json"`; `numCtx` pins the context window (used by
 *  the summarize stage, which sizes context to a whole chapter and refuses rather than truncate). */
export type Generate = (
  prompt: string,
  opts?: { numPredict?: number; temperature?: number; numCtx?: number; json?: boolean; signal?: AbortSignal },
) => Promise<string>;

/** Progress reporter. `total` is an ESTIMATE until consolidation is done (a merge adds a
 *  re-summary call), so it may be revised upward mid-run; `done` never goes backwards. */
export type OnProgress = (p: { phase: string; done: number; total: number }) => void;

export interface AnalyzeOptions {
  /**
   * Run stage 5 (consolidation). Default true.
   *
   * Set FALSE when the span handed in is already known to be ONE unit — a story the user has
   * defined and curated. Consolidation exists to decide where one story ends and the next begins;
   * inside a declared story there is no such seam to find, so every merge it makes is a false
   * positive that flattens two real chapters into one. Skipping it returns the stage-4 tier
   * directly, which IS the chapter layer.
   *
   * This is a correctness switch, not an optimisation — the saving is only about one call per
   * chapter, but a wrong merge here silently costs the user a chapter marker.
   */
  consolidate?: boolean;
}

/** Thrown when the user stops a run. Distinct from a failure so the UI never shows an error for
 *  something the user asked for — a run is hundreds of calls and stopping it is normal. */
export class AnalysisCancelledError extends Error {
  constructor() {
    super('Analysis stopped.');
    this.name = 'AnalysisCancelledError';
  }
}

// ── tuning constants ─────────────────────────────────────────────────────────
const STRETCH_SECONDS = 45;      // stage 1 granularity; also the accuracy of a raw junction (±45 s)
const MIN_CHAPTERS = 3;          // consolidation floor — never collapse below this
const MIN_BOUNDARY_GAP = 5;      // post-placement dedupe: boundaries closer than this collide
const QUOTE_KEY_WORDS = 12;      // words of a quote used to locate it in the word stream
const QUOTE_MIN_SCORE = 0.5;     // fractional-match floor when the exact run isn't found
const CTX_BUCKET = 4096;         // Ollama reloads on num_ctx change — quantize to reuse the load
const CHAPTER_CTX_MAX = 32768;   // summarize refuses above this rather than truncate a chapter

// Every call is temperature 0 + format:json. Not negotiable — see the header.
const TEMP = 0;

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

/** "4m 12s" — the length phrase handed to the consolidation judge. */
function lengthPhrase(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ── JSON parsing ─────────────────────────────────────────────────────────────
/** Parse the first {...} object out of a response. With format:json this is the whole body, but
 *  a model that ignores the format flag still parses here. Returns null on anything unusable. */
function parseJsonObject<T>(response: string): T | null {
  const match = (response || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return parsed && typeof parsed === 'object' ? (parsed as T) : null;
  } catch {
    return null;
  }
}

/** One model call with a single retry. Returns null when both attempts fail to produce parseable
 *  JSON — the caller decides what a miss means for its stage (never a silent fabrication). */
async function askJson<T>(
  generate: Generate,
  prompt: string,
  opts: { numPredict: number; numCtx?: number; signal?: AbortSignal },
  what: string,
): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    // Checked before EVERY attempt, not just once per call — otherwise a stop during the first
    // attempt would be swallowed by the retry and read as a model failure.
    if (opts.signal?.aborted) throw new AnalysisCancelledError();
    try {
      // The signal goes to the HTTP call too, so a stop kills the request in flight instead of
      // waiting out a summarize call that may be tens of seconds long.
      const resp = await generate(prompt, {
        numPredict: opts.numPredict,
        numCtx: opts.numCtx,
        temperature: TEMP,
        json: true,
        signal: opts.signal,
      });
      const parsed = parseJsonObject<T>(resp);
      if (parsed) return parsed;
      log.warn(`[ChapterSplitter] ${what}: unparseable response (attempt ${attempt + 1}): ${resp.slice(0, 200)}`);
    } catch (err) {
      // A stop propagates immediately; it is not a failed attempt to retry.
      if (opts.signal?.aborted || (err as Error)?.name === 'OllamaCancelledError') throw new AnalysisCancelledError();
      log.warn(`[ChapterSplitter] ${what}: call failed (attempt ${attempt + 1}): ${(err as Error)?.message}`);
    }
  }
  return null;
}

// ── quote → timestamp mapping ────────────────────────────────────────────────
function normalizeWords(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0);
}

/**
 * Map a verbatim quote to the second it is spoken.
 *
 * Matching runs against the FLATTENED word stream, never per segment: a sentence routinely
 * straddles two transcript segments, so per-segment matching misses it. Every word carries the
 * START TIME OF ITS SEGMENT — no interpolation. Word position inside a segment is not measured, so
 * inventing sub-segment precision would be inventing a number.
 *
 * Strategy: the quote's first 12 words as an exact run; failing that, the window position with the
 * best fractional agreement over those 12 (floor 0.5). Returns null when nothing clears the floor.
 */
function mapQuoteToTime(quote: string, segments: Segment[]): number | null {
  const words: string[] = [];
  const times: number[] = [];
  for (const seg of segments) {
    for (const w of normalizeWords(seg.text)) {
      words.push(w);
      times.push(seg.startSeconds);
    }
  }
  const key = normalizeWords(quote).slice(0, QUOTE_KEY_WORDS);
  if (key.length === 0 || words.length === 0) return null;

  for (let i = 0; i + key.length <= words.length; i++) {
    let ok = true;
    for (let k = 0; k < key.length; k++) {
      if (words[i + k] !== key[k]) { ok = false; break; }
    }
    if (ok) return times[i];
  }

  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < words.length; i++) {
    let hits = 0;
    for (let k = 0; k < key.length && i + k < words.length; k++) {
      if (words[i + k] === key[k]) hits++;
    }
    const score = hits / key.length;
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  return bestScore >= QUOTE_MIN_SCORE && bestIdx >= 0 ? times[bestIdx] : null;
}

// ── stretches ────────────────────────────────────────────────────────────────
interface Stretch {
  index: number;
  startSeconds: number;      // rebased to the span (0 = span start)
  endSeconds: number;
  segments: Segment[];
  text: string;
  about: string;             // stage-1 label — scaffolding for stage 2, never a chapter name
  startsHere: boolean;       // stage-1 signal, kept for diagnostics
  openingPhrase: string;     // stage-1 quote — the placement fallback when stage 3b misses
}

/** Cut the rebased transcript into contiguous 45 s stretches. Empty stretches are dropped. */
function cutIntoStretches(segments: Segment[], spanDuration: number): Stretch[] {
  const out: Stretch[] = [];
  for (let start = 0; start < spanDuration; start += STRETCH_SECONDS) {
    const end = Math.min(start + STRETCH_SECONDS, spanDuration);
    const segs = segments.filter(s => s.startSeconds >= start && s.startSeconds < end);
    if (segs.length === 0) continue;
    out.push({
      index: out.length,
      startSeconds: start,
      endSeconds: end,
      segments: segs,
      text: segs.map(s => s.text.trim()).join(' ').trim(),
      about: '',
      startsHere: false,
      openingPhrase: '',
    });
  }
  return out;
}

/** Text of the rebased segments in [start, end). */
function textForRange(segments: Segment[], start: number, end: number): string {
  return segments
    .filter(s => s.startSeconds >= start - 0.001 && s.startSeconds < end)
    .map(s => s.text.trim())
    .join(' ')
    .trim();
}

/**
 * Stage-4 rendering of the same range: one line per segment, each carrying its speaker tag.
 * ONLY summarize sees this — every other stage keeps the untagged text its sealed prompt was
 * tested on.
 */
function taggedTextForRange(segments: Segment[], start: number, end: number): string {
  return segments
    .filter(s => s.startSeconds >= start - 0.001 && s.startSeconds < end)
    .map(s => `${s.speaker === 'host' ? 'HOST:' : 'CLIP:'} ${s.text.trim()}`)
    .join('\n')
    .trim();
}

/** Last-resort label from a stretch's opening words — only used when a model call failed, and
 *  always logged when it happens. */
function deriveLabel(text: string): string {
  const words = text.split(/\s+/).slice(0, 8).join(' ').replace(/[.,;:]+$/, '');
  return words || 'Untitled';
}

// ── Stage 1 — label (one call per 45-second stretch) ─────────────────────────
function buildLabelPrompt(segment: string): string {
  return `Below is one short stretch of a YouTube commentary video's transcript. You are not writing
chapters. You are describing this stretch and nothing else.

TRANSCRIPT:
${segment}

Say what is being discussed here, in 3 to 6 words. Name the person, organisation, story or claim by
name wherever the transcript names one - "Mayor Ellison on the bridge contract" rather than "local
politics", "Halvorsen Trust fundraising" rather than "money". If the stretch is a sponsor read, a
Patreon plug, a sign-off or similar, say so plainly.

Then answer one question about WHERE that subject begins.

Read the opening words of the stretch. If the host was already mid-subject when this stretch
opened - already telling this story, already making this argument - then it started earlier and
"starts_here" is false. If instead the subject arrives somewhere inside this stretch, with the host
moving onto it from something else, "starts_here" is true.

Both answers are common and neither is safer. Most stretches land in the middle of a subject; do
not answer true just because you can find a sentence to point at.

Then quote the sentence that fixes the position:
- if starts_here is true, the exact sentence where the new subject arrives - the first sentence
  about it, not the last one before it
- if starts_here is false, the first sentence of the stretch

Copy it EXACTLY as it appears above, word for word, at least six words, no timestamps and no
tidying up. That quote is what fixes a chapter's start time to the second, so a quote you reworded
points at the wrong moment.

Return JSON only:
{"about": "<3-6 words>", "starts_here": true or false, "opening_phrase": "<exact quote from above>"}`;
}

interface LabelResult { about?: unknown; starts_here?: unknown; opening_phrase?: unknown }

// ── Stage 2 — rate each junction (one call per junction) ─────────────────────
function buildRatingPrompt(before: string, after: string, window: string): string {
  return `Here are two consecutive stretches of a YouTube commentary video.

The earlier stretch:  ${before}
The stretch after it: ${after}

TRANSCRIPT ACROSS THE TWO:
${window}

How much does the video change subject between them? Answer with one number:

0 - no change at all. Still the same story, the same person, the same argument. The second
    stretch is simply the first one continuing.
1 - a small move within one subject: a new angle on the same story, the rebuttal to the claim just
    made, reaction to the clip just played, another example of the same point.
2 - a clear move: the video finishes with what it was on and takes up something related but
    separate - a different incident involving the same people, or the same theme through a
    different story.
3 - a complete change: a different person or organisation, an unrelated story, or a sponsor read,
    Patreon plug, sign-off or channel promo starting or ending.

Most pairs of neighbouring stretches are 0 or 1 - a video does not change subject every minute.
Reserve 3 for the places a viewer would actually want a chapter mark.

Judge only these two stretches against each other. Do not think about the rest of the video, and do
not try to make the numbers come out evenly.

Return JSON only:
{"change": 0, "why": "<six words or fewer>"}`;
}

interface RatingResult { change?: unknown; why?: unknown }

interface Junction {
  index: number;        // sits between stretch[index] and stretch[index + 1]
  timeSeconds: number;  // = stretch[index + 1].startSeconds (rebased)
  change: number;       // 0-3
  why: string;
  rated: boolean;       // false when both attempts failed — never selectable
}

// ── Stage 3 — select boundaries (code only, zero model calls) ────────────────
/**
 * Target seconds per chapter, from cadence measured across 3,000+ published chapters:
 * ~2.2 min under 10 min, 3.5 at 10-30, 5.6 at 30-60, ~6 beyond an hour.
 */
function targetSecondsForDuration(durationSeconds: number): number {
  const minutes = durationSeconds / 60;
  if (minutes < 10) return 2.2 * 60;
  if (minutes < 30) return 3.5 * 60;
  if (minutes < 60) return 5.6 * 60;
  return 6 * 60;
}

function boundaryCountForDuration(durationSeconds: number, targetSeconds: number): number {
  return Math.max(MIN_CHAPTERS, Math.round(durationSeconds / targetSeconds)) - 1;
}

/**
 * Take boundaries in rank order (strongest change first), enforcing a minimum gap of 0.6 × target
 * against every boundary already chosen; ties break FARTHEST-FIRST from the chosen set. 0:00 is
 * always a chapter and is never scored, so it seeds the chosen set.
 *
 * Ranked, never thresholded — a near/far threshold test on these ratings looks like noise, but
 * ranking by them doubles end-to-end F1.
 */
function selectBoundaries(junctions: Junction[], count: number, minGap: number): Junction[] {
  const chosenTimes: number[] = [0];
  const chosen: Junction[] = [];
  const pool = junctions.filter(j => j.rated && j.timeSeconds > 0);

  while (chosen.length < count && pool.length > 0) {
    const eligible = pool.filter(j => chosenTimes.every(t => Math.abs(j.timeSeconds - t) >= minGap));
    if (eligible.length === 0) break;
    const maxChange = Math.max(...eligible.map(j => j.change));
    const top = eligible.filter(j => j.change === maxChange);

    let best = top[0];
    let bestDistance = -1;
    for (const cand of top) {
      const distance = Math.min(...chosenTimes.map(t => Math.abs(cand.timeSeconds - t)));
      if (distance > bestDistance) { bestDistance = distance; best = cand; }
    }
    chosen.push(best);
    chosenTimes.push(best.timeSeconds);
    pool.splice(pool.indexOf(best), 1);
  }

  return chosen.sort((a, b) => a.timeSeconds - b.timeSeconds);
}

// ── Stage 3b — place each boundary to the second (one call per boundary) ─────
function buildPlacementPrompt(before: string, after: string, window: string): string {
  return `Below is one stretch of a YouTube commentary video's transcript. Somewhere inside it the
video moves from one subject to the next.

What it was talking about:  ${before}
What it moves on to:        ${after}

TRANSCRIPT:
${window}

Find where the handover BEGINS - the first sentence a viewer would want to land on if they clicked
a chapter called "${after}".

That is the sentence where the host turns away from "${before}", which is usually a beat EARLIER
than the sentence that first explains the new subject. If the host says "anyway, let's talk about
X" and then explains X three sentences later, the turn is "anyway, let's talk about X" - quote
that, not the explanation. A viewer dropped at the explanation has missed the start.

So prefer, in this order:
1. the sentence where the host announces, introduces or turns toward the new subject
2. the sentence where the host closes off the old subject, if the turn is not announced
3. the first sentence that is plainly about the new subject, if there is no turn at all

Copy the sentence EXACTLY as it appears above, word for word, at least six words, no timestamps and
no tidying up. That quote is what fixes a chapter's start time to the second, so a quote you
reworded points at the wrong moment.

Return JSON only:
{"start_phrase": "<exact sentence from the transcript above>"}`;
}

interface PlacementResult { start_phrase?: unknown }

// ── Stage 4 — summarize each chapter (one call per chapter) ──────────────────
// Revised 2026-08-03 (audition3 A–E, scratchpad audition3*.js, real 2026-08-02 chapters): the
// original "say what happens, plainly" wording sanitized the host's framing out of every label
// ("Passenger kicked off plane for preaching" for a chapter that is the host calling the
// passenger a lying racist). The transcript is now HOST:/CLIP:-tagged and three bullets carry
// the host's verdict, correct attribution, and host-only stretches. Variant history: untagged
// tone bullet made "Host" the subject of 4/10 labels; tags without the attribution bullet
// inverted who did what. Same day, variant F added the "detail" field: the titling model was
// trained on real video descriptions (60–2200 chars of prose), so it is fed description-grade
// sentences, not the 4-8 word marker. Variants G/H harden against two failures F exposed on a
// story about an unnamed mayor: the example name leaking into output ("Mayor Ellison on
// Netanyahu arrest warrant" — hence the inoculation parenthetical, the de-named contrast pair,
// and the code-side `instructionNamed` retry, because the leak survived even the inoculation
// once) and outside-knowledge fabrication ("Mayor Eric Adams" for a transcript that names only
// Zoran Mamdani — reduced but NOT eliminated; details remain titler input that the user reviews,
// never published text). This wording is the tested artifact — do not "tidy" it.
function buildSummaryPrompt(start: string, end: string, transcript: string): string {
  return `Below is one chapter of a YouTube commentary video - the stretch from ${start} to ${end}.
It is one subject; the boundaries have already been decided.

TRANSCRIPT OF THIS CHAPTER (HOST: lines are the video's host speaking; CLIP: lines are the
footage the host is reacting to):
${transcript}

Describe what this chapter covers, in 4 to 8 words.

- Name the person, organisation, story or claim IF the transcript names one: "Mayor Ellison on the
  bridge contract scandal", not "a local corruption argument". (Ellison is invented for this
  instruction - never copy a name from these instructions into your answer.)
- If it names nobody, do not supply a name - describe what is there in its own words. A sponsor
  read, a Patreon plug, a sign-off or a channel promo should simply say that it is one. Never
  mention a person or story that this transcript does not - not even one you are sure of from
  outside knowledge. If the transcript only ever says "the mayor", write "the mayor".
- Cover the whole stretch, not just its opening. Where it genuinely moves through more than one
  thing, name what it spends most of itself on.
- The host's verdict is part of what happens. When the HOST lines dispute, debunk, mock or condemn
  what the CLIP lines claim, carry that verdict in how the story is described: "lies about
  the depot contract", not "discusses the depot contract"; "street closure rumour debunked", not
  "disputes claims about street closures". Keep the story as the
  subject - the words "host", "creator" and "commentary" must not appear in your answer; name what
  is shown, framed the way the host frames it. If the host takes no position, do not invent one.
- Attribute words and deeds to the right person. A claim in a CLIP line belongs to the person in
  the footage, and stays THEIR claim - if the clip's speaker says the inspector took a bribe and
  the host shows that claim is false, the chapter says the speaker lied about the inspector, not
  that the inspector took a bribe. When you cannot tell who did what, describe it neutrally
  rather than guess.
- A stretch that is only HOST lines (a sponsor read, a sign-up attempt, links, a sign-off) is
  named by the activity itself: "Patreon plug and channel links", not "Host promotes his
  Patreon".
- Say what happens, plainly. A viewer reads this as a chapter marker before clicking, and another
  model is handed it afterwards, so it has to carry the actual content. No headline writing, no
  teasing, no colons, no "Part 1".
- Never "Introduction", "Overview", "Background", "Conclusion", "Discussion", "Analysis",
  "Continued", "More on this".

Also write "detail": one or two sentences a video description would use for this chapter - every
name, organisation, claim and outcome that matters, using only names this transcript itself
provides, framed the way the host frames it, 20 to 45 words. All the rules above apply to it
too: right attribution, the host's verdict carried, no timestamps, no teasing.

Return JSON only:
{"about": "<4 to 8 words>", "detail": "<one or two sentences, 20 to 45 words>"}`;
}

interface SummaryResult { about?: unknown; detail?: unknown }

/**
 * Context needed to summarize a chapter, bucketed for Ollama. Estimated as words × 1.4 + 600.
 * Above CHAPTER_CTX_MAX this REFUSES: a summary of a chapter's opening teaches nothing about the
 * chapter, so truncating would produce a confidently wrong label.
 */
function chapterNumCtx(transcript: string, chapterIndex: number): number {
  const words = transcript.split(/\s+/).filter(Boolean).length;
  // +900, not the original +600: the prompt grew three bullets and the completion grew a
  // 20-45 word detail field (numPredict 240).
  const needed = Math.ceil(words * 1.4 + 900);
  if (needed > CHAPTER_CTX_MAX) {
    throw new Error(
      `Chapter ${chapterIndex} needs a ${needed}-token context to summarize (limit ${CHAPTER_CTX_MAX}). ` +
      `Refusing rather than summarizing a truncated chapter.`
    );
  }
  return Math.max(CTX_BUCKET, Math.ceil(needed / CTX_BUCKET) * CTX_BUCKET);
}

// ── Stage 5 — consolidate (one call per adjacent pair) ───────────────────────
function buildPairPrompt(aLength: string, aAbout: string, bLength: string, bAbout: string): string {
  return `Two consecutive chapters of one video:

Chapter A (${aLength}): ${aAbout}
Chapter B (${bLength}, comes straight after): ${bAbout}

Are these one story, or two?

They are ONE story when B is A continuing: the same case, incident or argument carried on, the
rebuttal to the claim A made, reaction to the clip A played, the same person or organisation stayed
with throughout.

They are TWO stories when the video genuinely moves on: a different person or organisation, an
unrelated incident, one story wrapped up and the next begun. A sponsor read, a Patreon plug or a
sign-off is always its own chapter, never part of the story beside it.

The same broad topic is NOT enough to make them one story - two different lawsuits about two
different churches are two stories. Both answers are common; decide from what the descriptions
actually say.

Return JSON only:
{"one_story": true or false, "why": "<six words or fewer>"}`;
}

interface PairResult { one_story?: unknown; why?: unknown }

interface DraftChapter {
  startSeconds: number;   // rebased
  endSeconds: number;
  about: string;
  detail: string;         // description-grade sentences from the same stage-4 call as `about`
  merged: boolean;        // true once it has absorbed a neighbour → needs a re-summary
  startApprox: boolean;   // start is a raw ±45 s junction, not a mapped quote
  /** The pre-consolidation chapters this draft covers, in time order. Seeded with itself after
   *  stage 4; absorbs the other side's members on every merge, so the fine tier survives the
   *  sweep instead of being spliced away with the chapter object. */
  members: SubChapter[];
}

// ── the pipeline ─────────────────────────────────────────────────────────────
/**
 * Split a span of transcript into consecutive subject chapters.
 *
 * `segments` carry ABSOLUTE original-timeline seconds; internally the span is rebased to 0 so
 * stretch cutting and quote mapping are 0-based, then chapter seconds are shifted back to absolute.
 *
 * Every stage runs sequentially — Ollama serves one request at a time, and determinism is the
 * point. Expect roughly `2 × (duration / 45 s) + 3 × chapters` calls: ~40 for a 12-minute video,
 * ~390 for a 2-hour livestream.
 */
export async function analyzeChapters(
  segments: Segment[],
  model: string,
  generate: Generate,
  onProgress?: OnProgress,
  signal?: AbortSignal,
  opts: AnalyzeOptions = {},
): Promise<Chapter[]> {
  if (!segments || segments.length === 0) throw new Error('No transcript in this span to analyze.');

  const spanStart = segments.reduce((mn, s) => Math.min(mn, s.startSeconds), Infinity);
  const spanEnd = segments.reduce((mx, s) => Math.max(mx, s.endSeconds), 0);
  const spanDuration = Math.max(0, spanEnd - spanStart);

  // Stage 4's speaker tags are only as good as the caller's labelling, so it is checked here,
  // not defaulted — an untagged segment silently rendered as CLIP would put the host's own
  // words in the footage's mouth.
  const badSpeaker = segments.findIndex(s => s.speaker !== 'host' && s.speaker !== 'clip');
  if (badSpeaker !== -1) {
    throw new Error(
      `Segment ${badSpeaker + 1} of ${segments.length} has speaker ` +
      `"${(segments[badSpeaker] as { speaker?: unknown }).speaker}" — every segment must be ` +
      `tagged 'host' (mic track) or 'clip' (screen track) by the caller.`
    );
  }

  const rel: Segment[] = segments
    .map(s => ({ text: s.text, speaker: s.speaker, startSeconds: s.startSeconds - spanStart, endSeconds: s.endSeconds - spanStart }))
    .sort((a, b) => a.startSeconds - b.startSeconds);

  // 14B is the floor. A full run on a 3B produced mega-chapters (one 32-minute chapter swallowing
  // three stories) — and a missed boundary is the one error the user cannot fix by hand.
  const paramMatch = (model || '').toLowerCase().match(/(\d+(?:\.\d+)?)\s*b\b/);
  const paramsB = paramMatch ? parseFloat(paramMatch[1]) : NaN;
  if (!Number.isNaN(paramsB) && paramsB < 14) {
    log.warn(
      `[ChapterSplitter] model "${model}" looks like ${paramsB}B. 14B is the validated floor for ` +
      `this method; smaller models miss boundaries, which cannot be fixed by joining. ` +
      `cogito:14b or qwen2.5:14b recommended.`
    );
  }

  // Input granularity is load-bearing and is NOT something this stage can repair, so it is checked
  // rather than absorbed. A segment is assigned to the stretch containing its START, and a mapped
  // quote resolves to the START TIME OF ITS SEGMENT — so segments longer than a stretch collapse
  // whole minutes into one stretch (leaving the rest empty) and cap placement precision at the
  // segment length. Callers must pass sentence-grained segments, not whole timeline clips.
  const durations = rel.map(s => Math.max(0, s.endSeconds - s.startSeconds)).sort((a, b) => a - b);
  const medianSegment = durations[Math.floor(durations.length / 2)] || 0;
  if (medianSegment > STRETCH_SECONDS) {
    throw new Error(
      `Transcript segments are too coarse to chapter: the median segment is ${medianSegment.toFixed(0)}s, ` +
      `longer than the ${STRETCH_SECONDS}s analysis stretch. Chapter starts would be no more accurate ` +
      `than that. Pass sentence-grained segments.`
    );
  }
  if (medianSegment > 15) {
    log.warn(
      `[ChapterSplitter] median transcript segment is ${medianSegment.toFixed(1)}s — chapter starts ` +
      `can be no more precise than that (the method targets ~5s).`
    );
  }

  const stretches = cutIntoStretches(rel, spanDuration);
  if (stretches.length === 0) throw new Error('No transcript in this span to analyze.');

  const targetSeconds = targetSecondsForDuration(spanDuration);
  const boundaryTarget = boundaryCountForDuration(spanDuration, targetSeconds);
  const minGap = 0.6 * targetSeconds;
  const junctionCount = Math.max(0, stretches.length - 1);

  log.info(
    `[ChapterSplitter] span ${secondsToClock(spanStart)}..${secondsToClock(spanEnd)} ` +
    `(${(spanDuration / 60).toFixed(1)} min) · ${segments.length} segments · model=${model} → ` +
    `${stretches.length} stretches · ${junctionCount} junctions · target ${(targetSeconds / 60).toFixed(1)} min/chapter ` +
    `→ ${boundaryTarget} boundaries (min gap ${Math.round(minGap)}s)`
  );

  // Consolidation is skipped when the caller already knows this span is one story — see
  // AnalyzeOptions.consolidate. Everything up to and including stage 4 is identical either way.
  const consolidate = opts.consolidate !== false;

  // Progress: stretches + junctions + boundaries + chapters (+ pairs, only when consolidating).
  // Merges add re-summary calls, so `total` is revised upward when that happens rather than
  // silently over-running.
  let done = 0;
  let total = stretches.length + junctionCount + boundaryTarget + (boundaryTarget + 1)
            + (consolidate ? boundaryTarget : 0);
  const step = (phase: string) => {
    done += 1;
    if (done > total) total = done;
    onProgress?.({ phase, done, total });
  };
  onProgress?.({ phase: 'Reading the transcript', done: 0, total });

  // ── Stage 1 — label every stretch ──────────────────────────────────────────
  let labelFailures = 0;
  for (const stretch of stretches) {
    const result = await askJson<LabelResult>(
      generate,
      buildLabelPrompt(stretch.text),
      { numPredict: 300, signal },
      `stretch ${stretch.index + 1}/${stretches.length} label`,
    );
    if (result && typeof result.about === 'string' && result.about.trim()) {
      stretch.about = result.about.trim();
      stretch.startsHere = result.starts_here === true;
      stretch.openingPhrase = typeof result.opening_phrase === 'string' ? result.opening_phrase : '';
    } else {
      labelFailures++;
      stretch.about = deriveLabel(stretch.text);
      log.warn(`[ChapterSplitter] stretch ${stretch.index + 1} label failed — using its opening words`);
    }
    step(`Reading stretch ${stretch.index + 1} of ${stretches.length}`);
  }
  if (labelFailures > stretches.length / 2) {
    throw new Error(
      `The model failed to label ${labelFailures} of ${stretches.length} transcript stretches. ` +
      `Its output is not usable — try cogito:14b or qwen2.5:14b.`
    );
  }
  if (labelFailures > 0) {
    log.warn(`[ChapterSplitter] stage 1: ${labelFailures}/${stretches.length} stretches fell back to derived labels`);
  }

  // ── Stage 2 — rate every junction ──────────────────────────────────────────
  const junctions: Junction[] = [];
  let ratingFailures = 0;
  for (let i = 0; i < stretches.length - 1; i++) {
    const before = stretches[i];
    const after = stretches[i + 1];
    const result = await askJson<RatingResult>(
      generate,
      buildRatingPrompt(before.about, after.about, `${before.text} ${after.text}`),
      { numPredict: 120, signal },
      `junction ${i + 1}/${junctionCount} rating`,
    );
    const raw = typeof result?.change === 'number' ? result.change : Number(result?.change);
    const rated = Number.isFinite(raw);
    if (!rated) {
      ratingFailures++;
      log.warn(`[ChapterSplitter] junction ${i + 1} rating failed — excluded from selection`);
    }
    junctions.push({
      index: i,
      timeSeconds: after.startSeconds,
      change: rated ? Math.max(0, Math.min(3, Math.round(raw))) : 0,
      why: typeof result?.why === 'string' ? result.why : '',
      rated,
    });
    step(`Rating change ${i + 1} of ${junctionCount}`);
  }
  if (junctionCount > 0 && ratingFailures > junctionCount / 2) {
    throw new Error(
      `The model failed to rate ${ratingFailures} of ${junctionCount} transcript junctions. ` +
      `Its output is not usable — try cogito:14b or qwen2.5:14b.`
    );
  }

  // Rating spread is the whole selection signal. A rater that answers the same number everywhere
  // degrades selection to uniform spacing — visible here, not guessed at later.
  const histogram = [0, 0, 0, 0];
  for (const j of junctions) if (j.rated) histogram[j.change]++;
  log.info(
    `[ChapterSplitter] stage 2: change ratings 0=${histogram[0]} 1=${histogram[1]} ` +
    `2=${histogram[2]} 3=${histogram[3]} (${ratingFailures} unrated)`
  );

  // ── Stage 3 — select boundaries (code only) ────────────────────────────────
  const selected = selectBoundaries(junctions, boundaryTarget, minGap);
  log.info(
    `[ChapterSplitter] stage 3: selected ${selected.length}/${boundaryTarget} boundaries at ` +
    selected.map(j => `${secondsToClock(j.timeSeconds)}(${j.change})`).join(' ')
  );

  // ── Stage 3b — place each boundary to the second ───────────────────────────
  // A junction is only accurate to ±45 s. The placement window is exactly the two stretches the
  // junction sits between, so a mapped quote can never land outside the ±45 s it is accurate to.
  //
  // When no quote maps, the boundary keeps the raw junction — bounded recovery, and far better
  // than dropping a chapter nobody can add back by hand. But it silently costs an order of
  // magnitude of precision (~5 s → ±45 s) and the resulting description looks perfectly normal,
  // so the degradation RIDES OUT ON THE CHAPTER as `startApprox` instead of only reaching a log
  // file. A user reading "12 ch · 3 approx" knows which starts to nudge; a user reading a warning
  // they never saw does not.
  const placed: { time: number; approx: boolean }[] = [{ time: 0, approx: false }];
  for (let i = 0; i < selected.length; i++) {
    const j = selected[i];
    const before = stretches[j.index];
    const after = stretches[j.index + 1];
    const windowSegments = [...before.segments, ...after.segments];
    const result = await askJson<PlacementResult>(
      generate,
      buildPlacementPrompt(before.about, after.about, `${before.text} ${after.text}`),
      { numPredict: 300, signal },
      `boundary ${i + 1}/${selected.length} placement`,
    );

    const quote = typeof result?.start_phrase === 'string' ? result.start_phrase : '';
    let time = quote ? mapQuoteToTime(quote, windowSegments) : null;
    if (time === null && after.openingPhrase) {
      // Still a MAPPED QUOTE, just a different one — same ~5 s accuracy, not a degradation.
      time = mapQuoteToTime(after.openingPhrase, windowSegments);
      if (time !== null) {
        log.warn(`[ChapterSplitter] boundary ${i + 1}: placement quote unmappable — used the stretch's own opening quote`);
      }
    }
    let approx = false;
    if (time === null) {
      time = j.timeSeconds;
      approx = true;
      log.warn(`[ChapterSplitter] boundary ${i + 1}: no quote mapped — falling back to the raw junction at ${secondsToClock(time)} (±45s)`);
    }

    // Placement can move a boundary backwards past its predecessor; keep the list strictly
    // increasing, preferring the raw junction over an out-of-order placement, and drop it if even
    // that collides rather than emitting a zero-length chapter.
    const previous = placed[placed.length - 1].time;
    if (time - previous < MIN_BOUNDARY_GAP) {
      if (j.timeSeconds - previous >= MIN_BOUNDARY_GAP) {
        log.warn(`[ChapterSplitter] boundary ${i + 1}: placement at ${secondsToClock(time)} collided with the previous boundary — using the raw junction`);
        time = j.timeSeconds;
        approx = true;   // same ±45 s junction, reached by a different route
      } else {
        log.warn(`[ChapterSplitter] boundary ${i + 1}: dropped — lands within ${MIN_BOUNDARY_GAP}s of the previous boundary`);
        step(`Placing boundary ${i + 1} of ${selected.length}`);
        continue;
      }
    }
    placed.push({ time, approx });
    step(`Placing boundary ${i + 1} of ${selected.length}`);
  }
  const approxCount = placed.filter(p => p.approx).length;
  if (approxCount > 0) {
    log.warn(
      `[ChapterSplitter] stage 3b: ${approxCount}/${placed.length} chapter starts fell back to the ` +
      `raw junction (±45s) — flagged on the returned chapters as startApprox`
    );
  }

  // ── Stage 4 — summarize each chapter ───────────────────────────────────────
  // These are the REAL chapter names, written from each chapter's actual transcript span. An
  // earlier design that summarized the stage-1 labels instead produced summary-of-summary mush.
  const drafts: DraftChapter[] = placed.map((p, i) => ({
    startSeconds: p.time,
    endSeconds: i < placed.length - 1 ? placed[i + 1].time : spanDuration,
    about: '',
    detail: '',
    merged: false,
    startApprox: p.approx,
    members: [],
  }));

  const hostNamed = (s: string) => /\b(host|creator)\b/i.test(s);
  // "Ellison" exists only as the prompt's invented example. A real Ellison in a transcript is
  // possible in principle, but a label copying the example is the overwhelmingly likelier read —
  // audition3g produced "Mayor Ellison on Netanyahu arrest warrant" for a story whose transcript
  // names no Ellison, on the first story that happened to be about an unnamed mayor.
  const instructionNamed = (s: string) => /\bellison\b/i.test(s);
  const ruleBroken = (s: string) => hostNamed(s) || instructionNamed(s);
  const summarize = async (chapter: DraftChapter, label: string): Promise<{ about: string; detail: string }> => {
    const transcript = textForRange(rel, chapter.startSeconds, chapter.endSeconds);
    if (!transcript) {
      // A silent stretch inside the span — nothing to summarize, and nothing to invent either.
      log.warn(`[ChapterSplitter] ${label}: no transcript between ${secondsToClock(chapter.startSeconds)} and ${secondsToClock(chapter.endSeconds)}`);
      return { about: 'Untitled', detail: '' };
    }
    const tagged = taggedTextForRange(rel, chapter.startSeconds, chapter.endSeconds);
    const numCtx = chapterNumCtx(tagged, drafts.indexOf(chapter) + 1);
    const prompt = buildSummaryPrompt(secondsToClock(chapter.startSeconds), secondsToClock(chapter.endSeconds), tagged);
    const result = await askJson<SummaryResult>(generate, prompt, { numPredict: 240, numCtx, signal }, label);
    let about = result && typeof result.about === 'string' ? result.about.trim() : '';
    let detail = result && typeof result.detail === 'string' ? result.detail.trim() : '';
    if (about && (ruleBroken(about) || ruleBroken(detail))) {
      // The prompt bans naming the host, and bans copying the instructions' invented example
      // name; cogito:14b still breaks each on occasion ("Host discusses X" on 3 of 10 chapters
      // in audition3, stable across three prompt variants — more wording did not move it). One
      // corrective re-ask fixed every case tried, so that is the enforcement: the prompt's own
      // rule, restated once with the offending answer. If the model insists a second time, its
      // answer stands and the log says so.
      const offending = ruleBroken(about) ? about : detail;
      const rule = hostNamed(offending)
        ? 'the rule against the word "host". Rewrite both fields: name the activity or story itself'
        : 'the rule against copying names from these instructions (Ellison is invented). Rewrite both fields using only names the transcript provides';
      const corrective =
        prompt + `\n\nYour previous answer was "${offending}". It broke ${rule}.`;
      const retry = await askJson<SummaryResult>(
        generate, corrective, { numPredict: 240, numCtx, signal }, `${label} rule retry`,
      );
      if (retry && typeof retry.about === 'string' && retry.about.trim()) {
        about = retry.about.trim();
        detail = typeof retry.detail === 'string' ? retry.detail.trim() : detail;
        if (ruleBroken(about) || ruleBroken(detail)) {
          log.warn(`[ChapterSplitter] ${label}: still rule-breaking after the corrective retry — keeping "${about}"`);
        }
      }
    }
    if (about) return { about, detail };
    log.warn(`[ChapterSplitter] ${label} failed — using the chapter's opening words`);
    return { about: deriveLabel(transcript), detail: '' };
  };

  for (let i = 0; i < drafts.length; i++) {
    const named = await summarize(drafts[i], `chapter ${i + 1}/${drafts.length} summary`);
    drafts[i].about = named.about;
    drafts[i].detail = named.detail;
    // Snapshot the fine tier the moment it is named — BEFORE consolidation can splice it away.
    drafts[i].members = [{
      startSeconds: drafts[i].startSeconds,
      endSeconds: drafts[i].endSeconds,
      label: drafts[i].about,
      detail: drafts[i].detail,
      startApprox: drafts[i].startApprox,
    }];
    step(`Naming chapter ${i + 1} of ${drafts.length}`);
  }

  // ── Stage 5 — consolidate adjacent pairs ───────────────────────────────────
  // EVERY adjacent pair is asked, with no gating. A gated version (only short-sided or
  // weak-junction pairs eligible) merged 1 of the 8 pairs that needed merging on the livestream
  // test: overshoot selects strong-but-intra-story junctions whose sides are full length, and a
  // gate never questions those. Merges apply immediately, so a story split three ways collapses in
  // a single sweep.
  const pairTotal = consolidate ? Math.max(0, drafts.length - 1) : 0;
  let pairIndex = 0;
  let merges = 0;
  let i = 0;
  if (!consolidate) {
    log.info(
      `[ChapterSplitter] stage 5 skipped — the caller declared this span a single story, so there ` +
      `is no story seam to find; returning the ${drafts.length}-chapter stage-4 tier`
    );
  }
  while (consolidate && i < drafts.length - 1) {
    if (drafts.length <= MIN_CHAPTERS) {
      log.info(`[ChapterSplitter] stage 5: stopped at the ${MIN_CHAPTERS}-chapter floor`);
      break;
    }
    const a = drafts[i];
    const b = drafts[i + 1];
    pairIndex++;
    const result = await askJson<PairResult>(
      generate,
      buildPairPrompt(
        lengthPhrase(a.endSeconds - a.startSeconds), a.about,
        lengthPhrase(b.endSeconds - b.startSeconds), b.about,
      ),
      { numPredict: 120, signal },
      `pair ${pairIndex}/${pairTotal} consolidation`,
    );
    step(`Merging chapter ${pairIndex} of ${pairTotal}`);

    if (result?.one_story === true) {
      // A's description carries the merged span through the rest of the sweep; the merged span is
      // re-summarized from its full transcript once the sweep finishes.
      log.info(`[ChapterSplitter] merge: "${a.about}" + "${b.about}" (${typeof result.why === 'string' ? result.why : ''})`);
      a.endSeconds = b.endSeconds;
      a.merged = true;
      a.members.push(...b.members);   // keep B's fine tier; the splice below is what used to lose it
      drafts.splice(i + 1, 1);
      merges++;
      continue;   // compare the merged chapter against the next one
    }
    if (result === null) {
      log.warn(`[ChapterSplitter] pair ${pairIndex} judgement failed — keeping them separate`);
    }
    i++;
  }
  log.info(`[ChapterSplitter] stage 5: ${merges} merges → ${drafts.length} chapters`);

  // Re-summarize every merged span from its FULL transcript — its label is currently only the
  // left-hand chapter's description, which does not describe the whole merged story.
  const mergedIndices = drafts.map((c, idx) => (c.merged ? idx : -1)).filter(idx => idx >= 0);
  if (mergedIndices.length > 0) total += mergedIndices.length;
  for (const idx of mergedIndices) {
    const renamed = await summarize(drafts[idx], `merged chapter ${idx + 1} re-summary`);
    drafts[idx].about = renamed.about;
    drafts[idx].detail = renamed.detail;
    step(`Re-naming merged chapter ${idx + 1}`);
  }

  onProgress?.({ phase: 'Done', done: total, total });

  const kept = drafts.reduce((n, c) => n + c.members.length, 0);
  log.info(`[ChapterSplitter] retained ${kept} pre-consolidation chapters across ${drafts.length} stories`);

  return drafts.map((c, idx) => ({
    index: idx + 1,
    startSeconds: c.startSeconds + spanStart,
    endSeconds: c.endSeconds + spanStart,
    label: c.about || deriveLabel(textForRange(rel, c.startSeconds, c.endSeconds)),
    detail: c.detail,
    verbalCue: false,
    // Only ever set, never cleared: a merged chapter keeps the LEFT side's start, so it keeps the
    // left side's placement accuracy too.
    ...(c.startApprox ? { startApprox: true } : {}),
    // Rebased to absolute original-timeline seconds, same frame as the chapter itself.
    subChapters: c.members
      .slice()
      .sort((a, b) => a.startSeconds - b.startSeconds)
      .map(m => ({
        startSeconds: m.startSeconds + spanStart,
        endSeconds: m.endSeconds + spanStart,
        label: m.label,
        detail: m.detail,
        ...(m.startApprox ? { startApprox: true } : {}),
      })),
  }));
}

// ── title suggestion (single story → one title) ──────────────────────────────
//
// A focused, single-title adaptation of ContentStudio's title guidance (front-load the subject,
// plain language over euphemism, concrete and specific, punchy). Returns ONE strong title for
// auto-filling a story label. Independent of the chapter pipeline above.
//
// TWO input shapes, and the caller's choice between them is not a detail:
//
//   • a SUBJECT LIST — the story's chapter labels, in order. Preferred whenever the story has
//     chapters. It is the whole story rather than an excerpt, it costs a few hundred tokens
//     instead of twelve thousand, and — the reason that actually matters — it is the same
//     conditioning shape the fine-tuned titling adapter takes. A working title written from
//     subjects previews what the adapter will produce; one written from transcript does not.
//   • a TRANSCRIPT — the fallback for a story with no chapters yet. Necessarily spliced (see
//     below), which is exactly why it is the fallback.
//
// The two get DIFFERENT prompts. Handing a list of chapter labels to the transcript prompt asks
// the model to find a real moment in something that contains none — it reads the labels as speech
// and invents the detail the wording demands.

/** Subject-list prompt: the story's chapters, whole and in order. No truncation — a chapter list
 *  for a two-hour story is still a few hundred tokens. */
function buildSubjectTitlePrompt(subjects: string[]): string {
  const list = subjects.map(s => `- ${s}`).join('\n');
  return `You are titling a video segment for an editor's story list. Below are the subjects the
segment covers, in order — its chapter list, the whole segment and not an excerpt. They are
descriptions written by an editor, not words anyone said out loud.

SUBJECTS:
${list}

Write ONE concise, specific title for the segment as a whole.

Rules:
- Front-load the subject in the first few words. Name who or what it is about.
- Title the segment as a whole. Lead with what it spends most of itself on, which is usually the
  subject the most entries describe — not simply the first one.
- Plain language over euphemism — say what actually happens.
- Use only the people, organisations and claims named above. Do not invent a detail the list does
  not contain, and do not quote anyone: nothing above is a quotation.
- 40-70 characters. No trailing punctuation. No surrounding quotes.

Return ONLY valid JSON, nothing else:
{ "title": "the title" }`;
}

/** Transcript prompt — the no-chapters fallback. Head-and-tail spliced at 12k chars with the
 *  MIDDLE DISCARDED, which is a real loss of the thing a title should be about; prefer subjects. */
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

/**
 * Generate a single suggested title for one story. Throws on failure.
 *
 * `input` is either the story's SUBJECT LIST (its chapter labels, in order — preferred) or its
 * raw transcript text. The shape decides the prompt; see the note above. An array that survives
 * a trim to nothing falls through to the same "nothing to title" refusal a blank transcript gets,
 * rather than prompting the model with an empty list and titling the void.
 */
export async function suggestTitle(input: string | string[], generate: Generate): Promise<string> {
  const subjects = Array.isArray(input)
    ? input.map(s => (s || '').trim()).filter(s => s.length > 0)
    : null;
  const text = Array.isArray(input) ? '' : (input || '').trim();
  if (subjects ? subjects.length === 0 : !text) {
    throw new Error('This story has nothing to title — no chapters and no transcript text.');
  }

  const prompt = subjects ? buildSubjectTitlePrompt(subjects) : buildTitlePrompt(text);
  // 0.2 ON PURPOSE (was silently inheriting ollama-service's default of the same value): this is
  // a one-shot working title for the story list — exactly one sample is taken, so temperature
  // buys variance with no selection step to spend it on. Not 0 like the sealed pipeline (this is
  // not a measurement), not 0.7 like the headline titler (which samples many and lets the user
  // pick).
  const response = await generate(prompt, { numPredict: 256, temperature: 0.2 });
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
  // PRE-EXISTING FALLBACK: unparseable JSON ⇒ take the first non-brace, non-fence line of the
  // model's own output and use it as the title. It is a different code path taken because the
  // call failed, and what it yields is indistinguishable from a real title to everything
  // downstream. Left as found and flagged rather than changed.
  const line = response
    .split('\n')
    .map(l => l.trim())
    .find(l => l && !l.startsWith('```') && !l.startsWith('{'));
  if (line) return line.replace(/^["']|["']$/g, '').slice(0, 120);
  throw new Error('The model did not return a usable title.');
}
