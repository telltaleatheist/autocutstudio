/**
 * Chapter Prompts — the sealed 14B chaptering method
 *
 * These five prompts are copied VERBATIM from CHAPTERING.md (sealed 2026-08-02),
 * which in turn copied them from the validated `chapter_prompts/` harness. They are
 * tested artifacts, not suggestions. Every line in them was paid for with a failed
 * architecture:
 *
 * - Nothing here ever shows the model a list, a count, or the whole video. A 14B
 *   cannot select K items from a list of N — it returns a prefix and stops. Each
 *   prompt asks ONE local question about ONE thing; code does all the counting,
 *   ranking, spacing and assembling (see chapter-pipeline.service.ts).
 * - The model NEVER emits a timestamp. It quotes a verbatim sentence and code maps
 *   that quote to a time against the caption word stream. An invented timestamp is a
 *   guess; a mapped quote is a measurement.
 * - The examples are invented and neutral-domain on purpose. A prompt example naming
 *   a real person leaks into outputs about a DIFFERENT unnamed person of the same
 *   archetype, deterministically, at temperature 0.
 *
 * Editing these without re-running the harness in the orpheus-finetune repo is how
 * the method gets quietly un-sealed. Change the code around them first.
 */

export const CHAPTER_PROMPTS = {
  /**
   * Stage 1 — label one 45-second stretch.
   * These labels are scaffolding for the stage-2 rater; they are NOT chapter names.
   * Placeholder: {segment}
   */
  LABEL: `Below is one short stretch of a YouTube commentary video's transcript. You are not writing
chapters. You are describing this stretch and nothing else.

TRANSCRIPT:
{segment}

Say what is being discussed here, in 3 to 6 words. Name the person, organisation, story or
claim by name wherever the transcript names one - "Alex Jones on Sandy Hook" rather than
"conspiracy theories", "TPUSA fundraising" rather than "money". If the stretch is a sponsor
read, a Patreon plug, a sign-off or similar, say so plainly.

Then answer one question about WHERE that subject begins.

Read the opening words of the stretch. If the host was already mid-subject when this stretch
opened - already telling this story, already making this argument - then it started earlier
and "starts_here" is false. If instead the subject arrives somewhere inside this stretch,
with the host moving onto it from something else, "starts_here" is true.

Both answers are common and neither is safer. Most stretches land in the middle of a
subject; do not answer true just because you can find a sentence to point at.

Then quote the sentence that fixes the position:
- if starts_here is true, the exact sentence where the new subject arrives - the first
  sentence about it, not the last one before it
- if starts_here is false, the first sentence of the stretch

Copy it EXACTLY as it appears above, word for word, at least six words, no timestamps and no
tidying up. That quote is what fixes a chapter's start time to the second, so a quote you
reworded points at the wrong moment.

Return JSON only:
{"about": "<3-6 words>", "starts_here": true or false, "opening_phrase": "<exact quote from above>"}`,

  /**
   * Stage 2 — rate how much the subject changes across one junction (0-3).
   * Do NOT threshold this signal; rank by it (see the pipeline's selection stage).
   * Placeholders: {before}, {after}, {window}
   */
  RATE_JUNCTION: `Here are two consecutive stretches of a YouTube commentary video.

The earlier stretch:  {before}
The stretch after it: {after}

TRANSCRIPT ACROSS THE TWO:
{window}

How much does the video change subject between them? Answer with one number:

0 - no change at all. Still the same story, the same person, the same argument. The second
    stretch is simply the first one continuing.
1 - a small move within one subject: a new angle on the same story, the rebuttal to the
    claim just made, reaction to the clip just played, another example of the same point.
2 - a clear move: the video finishes with what it was on and takes up something related but
    separate - a different incident involving the same people, or the same theme through a
    different story.
3 - a complete change: a different person or organisation, an unrelated story, or a sponsor
    read, Patreon plug, sign-off or channel promo starting or ending.

Most pairs of neighbouring stretches are 0 or 1 - a video does not change subject every
minute. Reserve 3 for the places a viewer would actually want a chapter mark.

Judge only these two stretches against each other. Do not think about the rest of the video,
and do not try to make the numbers come out evenly.

Return JSON only:
{"change": 0, "why": "<six words or fewer>"}`,

  /**
   * Stage 3b — place one selected boundary to the second.
   * The "turn, not arrival" ordering is load-bearing: an earlier prompt that rejected
   * "the sentence that merely hints at what is coming" placed boundaries 11.8s LATE on
   * average, because the hint IS where a human puts the mark.
   * Placeholders: {before}, {after}, {window}
   */
  PLACE_BOUNDARY: `Below is one stretch of a YouTube commentary video's transcript. Somewhere inside it the
video moves from one subject to the next.

What it was talking about:  {before}
What it moves on to:        {after}

TRANSCRIPT:
{window}

Find where the handover BEGINS - the first sentence a viewer would want to land on if they
clicked a chapter called "{after}".

That is the sentence where the host turns away from "{before}", which is usually a beat
EARLIER than the sentence that first explains the new subject. If the host says "anyway,
let's talk about X" and then explains X three sentences later, the turn is "anyway, let's
talk about X" - quote that, not the explanation. A viewer dropped at the explanation has
missed the start.

So prefer, in this order:
1. the sentence where the host announces, introduces or turns toward the new subject
2. the sentence where the host closes off the old subject, if the turn is not announced
3. the first sentence that is plainly about the new subject, if there is no turn at all

Copy the sentence EXACTLY as it appears above, word for word, at least six words, no
timestamps and no tidying up. That quote is what fixes a chapter's start time to the second,
so a quote you reworded points at the wrong moment.

Return JSON only:
{"start_phrase": "<exact sentence from the transcript above>"}`,

  /**
   * Stage 4 — summarize one chapter's ACTUAL transcript span in 4-8 words.
   * These are the real chapter names AND the subject list handed to the title,
   * description and tag stages. Summarizing the stage-1 labels instead of the
   * transcript produced summary-of-summary mush; that design is dead.
   * Placeholders: {start}, {end}, {transcript}
   */
  SUMMARIZE_CHAPTER: `Below is one chapter of a YouTube commentary video - the stretch from {start} to {end}. It
is one subject; the boundaries have already been decided.

TRANSCRIPT OF THIS CHAPTER:
{transcript}

Describe what this chapter covers, in 4 to 8 words.

- Name the person, organisation, story or claim IF the transcript names one: "Alex Jones on
  the TPUSA feud", not "a conspiracy theory argument".
- If it names nobody, do not supply a name - describe what is there in its own words. A
  sponsor read, a Patreon plug, a sign-off or a channel promo should simply say that it is
  one. Never mention a person or story that this transcript does not.
- Cover the whole stretch, not just its opening. Where it genuinely moves through more than
  one thing, name what it spends most of itself on.
- Say what happens, plainly. A viewer reads this as a chapter marker before clicking, and
  another model is handed it afterwards, so it has to carry the actual content. No headline
  writing, no teasing, no colons, no "Part 1".
- Never "Introduction", "Overview", "Background", "Conclusion", "Discussion", "Analysis",
  "Continued", "More on this".

Return JSON only:
{"about": "<4 to 8 words>"}`,

  /**
   * Stage 5 — one story or two? Asked about EVERY adjacent pair.
   * A gated version (only short-sided or weak-junction pairs eligible) merged 1 of the
   * 8 pairs that needed merging on the livestream test.
   * Placeholders: {a_length}, {a_about}, {b_length}, {b_about}
   */
  CONSOLIDATE_PAIR: `Two consecutive chapters of one video:

Chapter A ({a_length}): {a_about}
Chapter B ({b_length}, comes straight after): {b_about}

Are these one story, or two?

They are ONE story when B is A continuing: the same case, incident or argument carried on,
the rebuttal to the claim A made, reaction to the clip A played, the same person or
organisation stayed with throughout.

They are TWO stories when the video genuinely moves on: a different person or organisation,
an unrelated incident, one story wrapped up and the next begun. A sponsor read, a Patreon
plug or a sign-off is always its own chapter, never part of the story beside it.

The same broad topic is NOT enough to make them one story - two different lawsuits about
two different churches are two stories. Both answers are common; decide from what the
descriptions actually say.

Return JSON only:
{"one_story": true or false, "why": "<six words or fewer>"}`,
};
