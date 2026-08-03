/**
 * Centralized System Prompts
 * All hardcoded AI prompts in one place for easy editing
 */

export const SYSTEM_PROMPTS = {
  /**
   * Core JSON format enforcement - prepended to all metadata requests
   */
  JSON_SYSTEM: `Return a valid JSON object containing ONLY the fields requested below.
Use ASCII characters only. No markdown, no explanation - just the JSON object.`,

  /**
   * Compilation mode context
   * Placeholders: {sourceCount}, {contentTypes}
   */
  COMPILATION_CONTEXT: `
=== COMPILATION MODE ===
This is a COMPILATION of {sourceCount} separate items ({contentTypes}).

CRITICAL REQUIREMENTS:
1. For the TITLE: Pick the SINGLE most compelling item and base the title on that ONE subject.
   - DO NOT merge or blend subjects from different items into one title
   - Each item covers a SEPARATE topic - treat them as unrelated
   - Either use ONE item's subject OR use a generic compilation title (e.g., "3 Stories That...")
   - WRONG: "MAGA Influencer George Washington Is Weird" (merging two unrelated subjects)
   - CORRECT: "Glenn Beck's AI George Washington Is Unhinged" (one subject)
   - CORRECT: "3 Wild Political Stories You Need to See" (generic umbrella)

2. For the DESCRIPTION: Generate ONLY a bulleted list - nothing else!
   - NO intro paragraph before the list
   - NO outro paragraph after the list
   - ONLY the bulleted list itself
   - Use "-" prefix for each line
   - Write exactly {sourceCount} lines (one per item)
   - Each line: compelling 1-2 sentence summary in your editorial voice
   - NEVER write "This compilation also covers..." or "This compilation includes..." or any sentence starting with "This compilation"
   - NEVER add any framing, context, or commentary around the bullets — output ONLY the bulleted lines

   CRITICAL: The order MUST match the ITEM numbers below!
   - Line 1 of your list = ITEM 1
   - Line 2 of your list = ITEM 2
   - And so on...

CORRECT DESCRIPTION FORMAT (just this, nothing else):
- Summary for ITEM 1 here
- Summary for ITEM 2 here
- Summary for ITEM 3 here

WRONG (do not do this):
Here's a compilation about religious grifters...  <-- NO intro text
- First bullet
- Second bullet
This compilation also covers Topic X...  <-- NO framing text
Watch these people embarrass themselves...  <-- NO outro text
===
`,

  /**
   * Compilation mode instructions override
   * Appended AFTER the prompt set's instructions_prompt to replace the
   * TITLES / DESCRIPTION / TAGS rules when in compilation mode.
   * Placeholder: {sourceCount}
   */
  COMPILATION_INSTRUCTIONS_OVERRIDE: `
## COMPILATION MODE OVERRIDES

This is a compilation of {sourceCount} separate items. The rules in this section REPLACE the TITLES, DESCRIPTION, and TAGS rules above. Every other section (thumbnail text, hashtags, pinned comment, chapters, output format, self-check) still applies unchanged.

TITLES (replaces the rules above):
- Generate 10 title options, 45-60 characters each
- Each title must focus on ONE specific item's subject OR use a generic umbrella title
- DO NOT merge/blend subjects from different items into one title
- Include a mix: some titles based on different items, some umbrella titles
- Example umbrella: "{sourceCount} Stories That Will Blow Your Mind" (illustration only — never output it verbatim)

DESCRIPTION (replaces the rules above):
- Generate ONLY a bulleted list using "-" prefix (no intro or outro text)
- Write exactly {sourceCount} bullet points (one per item, in ITEM order)
- Each bullet: compelling 1-2 sentence summary of that item's subject
- NEVER write "This compilation also covers..." or any framing text — ONLY output the bulleted lines

TAGS (replaces the rules above):
- 15-20 tags that reflect ALL {sourceCount} items in the compilation
- Include key names, topics, and themes from EACH item
- Mix of broad topics and specific phrases
- Format as comma-separated list
`,

  /**
   * Chapter subjects, prepended to the metadata prompt's subject block.
   *
   * Chapters are generated FIRST now, by the local pipeline in
   * chapter-pipeline.service.ts, and each subject was written from that chapter's own
   * transcript span. So this block is not a hint — it is a measured table of contents,
   * and it is the most reliable statement of what the video actually contains that the
   * metadata model gets. Kept deliberately general: it says what the list IS and what
   * to do with it, and leaves the editorial judgement to the prompt set.
   *
   * Placeholder: {chapterList}
   */
  CHAPTER_SUBJECTS_CONTEXT: `
=== WHAT THIS VIDEO ACTUALLY COVERS ===
The chapters below were already worked out from the transcript, in order, each one
described from its own section of the video. This is the video's real contents, and it
is what viewers will see listed under it.

{chapterList}

Let this list decide what the video is ABOUT. Weight it by how much of the video each
subject takes up, and stay inside it - if something is not in this list, the video did
not spend real time on it.
===
`,

  /**
   * Episode split prompt - for finding episode boundaries in multi-hour streams
   * The transcript comes from multiple sequential audio files concatenated with global timestamps
   * Placeholders: {transcript}, {duration}, {episodeCount}
   */
  EPISODE_SPLIT_PROMPT: `You are analyzing a transcript from a continuous multi-hour livestream (total duration: {duration}).
The stream was recorded in multiple sequential files that have been combined into one continuous transcript. Time markers in the form [H:MM:SS] (for example [1:35:00]) are inserted throughout the text every few minutes — each marks how far into the stream that point occurs. Use these markers to measure elapsed time and pace the episode boundaries.

Your task: Split this stream into approximately {episodeCount} episodes of roughly 1 hour each.

RULES FOR EPISODE BOUNDARIES:
1. Target duration: ~60 minutes per episode — use the [H:MM:SS] markers to gauge this
2. Maximum duration: 70 minutes (1 hour 10 minutes) - NEVER exceed this
3. SPREAD the boundaries across the ENTIRE runtime, all the way to {duration} - do not bunch them early or stop partway. Consecutive boundaries should sit roughly 60 minutes apart on the [H:MM:SS] markers, so every episode comes out roughly the same length (the shortest at least 70% as long as the longest).
4. Find natural topic/subject changes near each ~60-minute target
5. Look for verbal break cues where the host manually inserted break points:
   - "tell me what you think in the comments"
   - "this is [name] and he's/she's talking about [topic]" (intro patterns)
   - Sign-off phrases, outros, or transitions like "alright, moving on..."
   - "subscribe", "like and share", "see you next time" type phrases
   - Any clear verbal indication the host intended a break here
6. Prefer placing breaks at verbal cues even if the resulting episode is shorter than 60 minutes
7. The first episode MUST start at the very beginning of the transcript

For each episode provide:
1. start_phrase: An exact quote (5-10 words) of the SPOKEN words from where this episode begins in the transcript
2. title: A brief topic label or subject name for this episode segment
3. description: 1-2 sentences summarizing what this episode covers
4. verbal_cue_nearby: true/false - whether a verbal break cue was detected near this boundary

Return ONLY valid JSON:
{
  "episodes": [
    {
      "start_phrase": "exact quote from transcript",
      "title": "Episode Topic",
      "description": "Summary of what this episode covers...",
      "verbal_cue_nearby": false
    }
  ]
}

CRITICAL RULES:
- start_phrase MUST be verbatim spoken text copied from the transcript (5-10 consecutive words)
- NEVER quote a [H:MM:SS] time marker as a start_phrase - those are inserted markers, not spoken words. Quote the actual words spoken at that point instead.
- The transcript may be an evenly-sampled excerpt (some sentences omitted between lines) - quote start_phrase EXACTLY as it appears in the text provided, never bridge or paraphrase across gaps
- The first episode's start_phrase should be from the very beginning of the transcript
- DO NOT paraphrase or modify the text - copy EXACTLY as written
- Episodes are sequential - each one ends where the next begins
- The last episode ends at the end of the stream
- Output valid JSON only, no markdown or extra text

Transcript:
{transcript}`,
};

/**
 * Helper to replace placeholders in prompts
 */
export function formatPrompt(
  prompt: string,
  replacements: Record<string, string | number>
): string {
  let result = prompt;
  for (const [key, value] of Object.entries(replacements)) {
    // Function replacer: a plain string replacement would interpret $-patterns
    // ($&, $', $`) inside transcript text and corrupt the prompt.
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), () => String(value));
  }
  return result;
}
