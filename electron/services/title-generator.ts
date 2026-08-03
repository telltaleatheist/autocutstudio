// electron/services/title-generator.ts
//
// YouTube title suggestions from a video's subject list, served by a LOCAL fine-tuned
// model through Ollama (`headline-14b-titles`, a Qwen3-14B derivative).
//
// The contract with that model is FIXED and byte-exact — it is what the model was trained
// on, not a prompt to be improved:
//
//   • Two chat messages, system + user, rendered by the model's own chat template
//     (hence /api/chat, never /api/generate).
//   • The system prompt is chosen by FORMAT (normal upload vs livestream) and is used
//     verbatim. Do not reword, reflow, or "fix" the punctuation in SYSTEM_PROMPTS —
//     the en dashes, the hyphens and the lower-case are all part of the trained string.
//   • The user turn is exactly:
//
//         task: title
//         format: <normal|livestream>
//         target: <top-decile|strong|typical|weak>
//
//         Video:
//         - subject line
//         - subject line
//
//   • The model NEVER sees a timestamp and never emits one. Chapter lines arrive from the
//     editor with clocks on them; `stripSubjectLine` removes them here, in code.
//
// One completion = one title. Ten suggestions means ten independent calls at temperature
// 0.7 — the variety IS the sampling. Duplicates are dropped rather than resampled: chasing
// a fixed count of unique titles would loop unboundedly on a model that has settled.
//
// Doctrine: no silent fallbacks. A missing model, a stopped Ollama, an empty completion —
// all propagate verbatim to the UI. There is no second model to fall back to.
import * as log from 'electron-log';
import type { ChatMessage, ChatOptions } from './ollama-service';

/** The one model this feature speaks to. Never substituted — a missing model is an error. */
export const TITLE_MODEL = 'headline-14b-titles';

export type TitleFormat = 'normal' | 'livestream';
export type TitleTarget = 'top-decile' | 'strong' | 'typical' | 'weak';

export const TITLE_TARGETS: TitleTarget[] = ['top-decile', 'strong', 'typical', 'weak'];

/**
 * Character ranges the two formats are trained to hit. Shown next to each suggestion so the
 * user can see at a glance which ones landed — advisory, never enforced (a good 72-character
 * title is not thrown away because the band says 70).
 */
export const TITLE_LENGTH_RANGE: Record<TitleFormat, { min: number; max: number }> = {
  normal: { min: 45, max: 70 },
  livestream: { min: 45, max: 90 },
};

/**
 * The trained system prompts, VERBATIM. Changing a character here changes the model's
 * behaviour — these are the strings it was fine-tuned against.
 */
export const SYSTEM_PROMPTS: Record<TitleFormat, string> = {
  normal:
    'You write YouTube titles for independent commentary channels covering religion, politics and the far right - the atheist, ex-religious, skeptic and left-of-centre corner of YouTube. Given a description of a video, write one title. Name names; plain concrete language, no corporate phrasing; be the prosecutor, not the journalist - state what happened and why it matters, don\'t hedge. Specificity plus an open loop beats vague drama. This is a standard upload: the hook lands inside the first 45 characters and the whole title runs 45-70 characters, covering one story.',
  livestream:
    'You write YouTube titles for independent commentary channels covering religion, politics and the far right - the atheist, ex-religious, skeptic and left-of-centre corner of YouTube. Given a description of a video, write one title. Name names; plain concrete language, no corporate phrasing; be the prosecutor, not the journalist - state what happened and why it matters, don\'t hedge. Specificity plus an open loop beats vague drama. This is a livestream and the description lists the separate stories it worked through. Pick the one story with the strongest hook and write the title to that; naming two or three is acceptable only when no single story carries it. Run 45-90 characters.',
};

// ── Subject-line normalisation ───────────────────────────────────────────────
// Chapter lines reach us however the user pasted them (or however the editor formatted
// them): bulleted, numbered, clocked. The model was trained on bare "- subject" lines with
// NO time information, so everything else is stripped here.

/** Leading bullet/number markers: "- ", "* ", "• ", "1. ", "1) ". */
const LEADING_MARKER = /^\s*(?:[-*•–—]+|\d{1,3}[.)])\s+/;

/**
 * A clock at the start of a line: `0:00`, `12:34`, `1:23:45`, optionally wrapped in
 * (), [] or {}, optionally followed by a separator (-, –, —, :, |, ·).
 */
const LEADING_TIMESTAMP =
  /^\s*[\(\[\{]?\s*\d{1,3}:\d{2}(?::\d{2})?(?:\.\d{1,3})?\s*[\)\]\}]?\s*(?:[-–—:|·]+\s*)?/;

/**
 * Normalise ONE pasted line into the subject text the model should see, or '' if the line
 * carries no subject (blank, or nothing but a timestamp). Markers and clocks are stripped
 * repeatedly because real chapter lists nest them ("- 0:00 - Intro").
 */
export function stripSubjectLine(raw: string): string {
  let s = (raw ?? '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.replace(LEADING_MARKER, '');
    s = s.replace(LEADING_TIMESTAMP, '');
    if (s === before) break;
  }
  return s.trim();
}

/** Split a pasted block into clean subject lines, dropping blanks and timestamp-only lines. */
export function parseSubjects(text: string): string[] {
  return (text ?? '')
    .split(/\r?\n/)
    .map(stripSubjectLine)
    .filter((s) => s.length > 0);
}

/** Build the user turn. Shape is byte-exact — see the header. */
export function buildUserPrompt(subjects: string[], format: TitleFormat, target: TitleTarget): string {
  const bullets = subjects.map((s) => `- ${s}`).join('\n');
  return `task: title\nformat: ${format}\ntarget: ${target}\n\nVideo:\n${bullets}`;
}

/** The two messages for one title call. */
export function buildMessages(subjects: string[], format: TitleFormat, target: TitleTarget): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPTS[format] },
    { role: 'user', content: buildUserPrompt(subjects, format, target) },
  ];
}

// ── Response cleaning ────────────────────────────────────────────────────────

/**
 * Reduce a completion to the bare title. Defensive on purpose: `think:false` should mean no
 * reasoning block ever arrives, but a template change upstream must not put "<think>" into the
 * user's title list. Also drops the wrapping quotes and "Title:" prefixes a chat-tuned base
 * occasionally adds.
 *
 * Returns '' when nothing survives — the caller treats that as a failed sample, not a title.
 */
export function cleanTitle(raw: string): string {
  let s = raw ?? '';
  // Balanced reasoning blocks.
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, ' ');
  // An unbalanced close (streamed reasoning with the open tag suppressed): keep what follows.
  const lastClose = s.toLowerCase().lastIndexOf('</think>');
  if (lastClose !== -1) s = s.slice(lastClose + '</think>'.length);
  // An unbalanced open with no close is ALL reasoning — nothing usable follows it.
  const openIdx = s.toLowerCase().indexOf('<think>');
  if (openIdx !== -1) s = s.slice(0, openIdx);

  s = s.trim();
  // First non-empty line only; a title is one line by definition.
  const firstLine = s.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  s = firstLine;
  s = s.replace(/^(?:title|headline)\s*[:\-–—]\s*/i, '');
  // Strip matched wrapping quotes (straight or curly), possibly doubled.
  for (let i = 0; i < 3; i++) {
    const m = /^(["'“‘])([\s\S]*)(["'”’])$/.exec(s.trim());
    if (!m) break;
    s = m[2];
  }
  return s.trim();
}

// ── The run ──────────────────────────────────────────────────────────────────

export interface TitleRunOptions {
  subjects: string[];
  format: TitleFormat;
  target: TitleTarget;
  /** How many completions to request. Unique survivors may be fewer — duplicates are dropped. */
  count: number;
  /** Simultaneous in-flight calls. A 14B on local hardware does not like a wide fan-out. */
  concurrency?: number;
  /** Injected so the caller owns model/host/signal — same shape as chapter-splitter's `generate`. */
  chat: (messages: ChatMessage[], opts?: ChatOptions) => Promise<string>;
  /**
   * Fired after EVERY completion so the progress bar advances even on a duplicate or a dud;
   * `title` is present only when that completion produced a new, unique suggestion.
   */
  onProgress?: (p: { done: number; total: number; title?: string }) => void;
  signal?: AbortSignal;
}

/**
 * Sampling parameters. Fixed, not exposed: they are part of the method the model was tuned
 * against, and a slider on them would make one user's results incomparable to another's.
 */
const SAMPLING: ChatOptions = { temperature: 0.7, topP: 0.9, numPredict: 64 };

/**
 * Run `count` independent title completions and return the unique ones in completion order.
 *
 * Failure is loud and immediate: the first non-cancellation error aborts the remaining calls
 * and propagates. If Ollama is down or the model is missing, every call would fail the same
 * way — reporting three of ten titles over a broken backend would be worse than reporting
 * nothing.
 */
export async function generateTitles(opts: TitleRunOptions): Promise<{ titles: string[] }> {
  const { subjects, format, target, count, chat, onProgress, signal } = opts;
  if (!Array.isArray(subjects) || subjects.length === 0) {
    throw new Error('No subjects provided — paste the video’s chapter/subject list first.');
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`Title count must be a positive integer, got: ${count}`);
  }
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 3, count));
  const messages = buildMessages(subjects, format, target);
  log.info(
    `[Titles] ${count} completions · format=${format} target=${target} ` +
    `subjects=${subjects.length} concurrency=${concurrency}`
  );

  const titles: string[] = [];
  const seen = new Set<string>();
  let issued = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted) return;
      if (issued >= count) return;
      issued++;
      const text = await chat(messages, { ...SAMPLING, signal });
      done++;
      const title = cleanTitle(text);
      if (!title) {
        // A completion that cleaned away to nothing is a dud sample, not a run failure —
        // it is counted and skipped, never emitted as a blank suggestion.
        log.warn(`[Titles] completion ${done}/${count} produced no usable title`);
        onProgress?.({ done, total: count });
        continue;
      }
      const key = title.trim().toLowerCase();
      if (seen.has(key)) {
        onProgress?.({ done, total: count });
        continue;
      }
      seen.add(key);
      titles.push(title);
      onProgress?.({ done, total: count, title });
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  log.info(`[Titles] ${titles.length} unique title(s) from ${done} completion(s)`);
  return { titles };
}
