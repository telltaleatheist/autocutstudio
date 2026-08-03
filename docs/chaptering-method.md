# Chaptering with a local 14B — the sealed method

How the editor turns a transcript into chapters. Sealed 2026-08-02 after passing the ultimate
test: a 2:10:46 livestream chaptered against the creator's own story list — all 7 stories found,
in order, with the intro, the mid-stream app demo and the sign-off correctly isolated.

Implementation: `electron/services/chapter-splitter.ts`. Reference implementation the prompts were
lifted from, verbatim: `chapter_harness.py` + `chapter_prompts/` in the `orpheus-voice-finetune`
repo (telltaleatheist). **The prompt bodies are tested artifacts, not suggestions — do not reword
them.**

Chapters are the FIRST stage of the downstream pipeline. The user curates the chapter list (marks
which chapters belong to a video, joins any strays) and the curated subject list — timestamps
stripped — is what title, description and tag generation condition on. So chapters are both a
shipped product (clickable description links, starts must land within ~5 s) and the conditioning
input for everything after.

## The one law that shaped everything

**A 14B cannot select K items from a list of N.** Ask it which 12 of 70 candidate boundaries are
real and it returns a prefix — the first few — and stops. This sank five architectures
(whole-transcript chaptering, windowed lists, merge lists, delete-the-dividers, pick-the-headings)
before it was isolated. The fix is absolute:

> **No model call ever sees a list, a count, or the whole video. Every call asks ONE local question
> about ONE thing. Code does all counting, ranking, spacing and assembling.**

Corollaries, each learned the hard way:

- **The model never emits a timestamp.** It quotes a verbatim sentence; code maps the quote to a
  time by matching words against the transcript's word stream. An invented timestamp is a guess; a
  mapped quote is a measurement.
- **Temperature 0 always, `format: json` always.** At temp > 0 a single-video result is not a
  measurement — the same config scored 0.50 then 0.00 on consecutive runs.
- **Worked examples leak.** A prompt example naming a real person WILL surface in outputs where the
  input has an unnamed person of the same archetype (a real name from a prompt example appeared in
  3 of 2,828 outputs, deterministically, at temp 0). Use invented, neutral-domain examples.
- **Prompts that demand what the input lacks get fabrications.** Ask for a name when the span names
  nobody and the model supplies the highest-prior name for that archetype. Every naming prompt
  needs an explicit no-name branch.

## Model requirements

- **14B is the floor.** A full end-to-end run on a 3B produced mega-chapters (one 32-minute chapter
  swallowing three stories) and mislabelled spans. Small models fail in the direction the user
  *cannot* fix by joining — missed boundaries.
- `cogito:14b` is the best chaptering model measured here. `qwen2.5:14b` is the validated rater
  (healthy 0–3 spread); cogito rates with less variance on some corpora. When results look flat,
  check the rating histogram logged by stage 2 and try qwen2.5:14b.
- Local Ollama, `temperature 0`, `format: json`, one model resident at a time, unloaded
  (`keep_alive: 0`) when the run finishes.

## The pipeline: label → rate → select → summarize → consolidate

No stage sees the whole video. A 3-hour livestream and a 12-minute upload run identical logic —
only the number of calls differs.

| stage | calls | what it asks |
|---|---|---|
| 1 label | one per 45 s stretch | what is discussed here, in 3–6 words (+ a verbatim opening quote) |
| 2 rate | one per junction | how much does the subject change across this seam, 0–3 |
| 3 select | **zero** | code: duration-derived count, rank by rating, enforce min gap |
| 3b place | one per boundary | quote the sentence where the host *turns* to the new subject |
| 4 summarize | one per chapter | the real 4–8 word chapter name, from the chapter's own transcript |
| 5 consolidate | one per adjacent pair | one story or two? merges apply immediately |

Stage-1 labels are **scaffolding for stage 2 — they are NOT the chapter names.** An earlier design
that summarized labels instead of transcript produced summary-of-summary mush.

**Do not threshold the stage-2 signal — rank by it.** Individually the ratings look weak (AUC ~0.55
against reference boundaries), but ranking junctions by rating doubles end-to-end F1 versus not
ranking. Judge any selector end-to-end, never by a near/far threshold test.

**Stage 3 cadence**, measured across 3,000+ published chapters: ~2.2 min/chapter under 10 min, 3.5
at 10–30, 5.6 at 30–60, ~6 beyond an hour. `count = max(3, round(duration / target)) - 1`
boundaries; minimum gap `0.6 × target`; ties break farthest-first from already-chosen boundaries.
0:00 is always a chapter and is never scored.

**Stage 3b's "turn, not arrival" ordering matters.** An earlier prompt that rejected "the sentence
that merely hints at what is coming" placed boundaries 11.8 s late on average, because the hint IS
where a human puts the mark. Quote→timestamp mapping runs against the FLATTENED word stream, never
per transcript segment — a sentence routinely straddles two segments. Match the quote's first 12
words exactly, fall back to the best fractional match (floor 0.5).

**Stage 4 must not truncate.** Estimate tokens as `words × 1.4 + 600` and REFUSE (raise) rather
than truncate — a summary of a chapter's opening teaches nothing about the chapter. A ~18-minute
consolidated chapter needs `num_ctx` 16384.

**Stage 5 asks about EVERY adjacent pair.** A gated version (only short-sided or weak-junction
pairs eligible) merged 1 of the 8 pairs that needed it on the livestream test: overshoot selects
strong-but-intra-story junctions whose sides are full length, and a gate never questions those.
Wide eligibility took 21 chapters → 13 and fixed every multi-way story split it saw. Protect
against over-collapse with a minimum chapter count (3) — and remember the user curation step is the
real backstop. **The errors that survive wide consolidation are over-splits, which the user fixes
by joining in one click. Under-splits are the errors to fear, because nobody can fix them by
hand.** The forced count over-segments on purpose.

## Input granularity is load-bearing

The caller must pass **sentence-grained** segments. Two things depend on it, and neither can be
repaired downstream:

- A segment is assigned to the stretch containing its START, so segments longer than 45 s collapse
  whole minutes into one stretch and leave the rest empty.
- A mapped quote resolves to **the start time of its segment** — no interpolation, because word
  position inside a segment is not measured and inventing it would be inventing a number. So
  placement precision is bounded by segment length. The method targets ~5 s; 5-8 s segments are
  right.

The editor's transcript GROUPS are one timeline clip's worth of speech — on an uncut recording that
can be the whole hour, so they are unusable here. `segmentsForRegions()` therefore builds segments
from per-word timings (sentence punctuation, 20-word cap, 2 s pause, clip change), not from groups.
`analyzeChapters` refuses outright when the median segment exceeds 45 s and warns above 15 s.

## Cost and runtime

Calls ≈ `2 × (duration / 45 s) + ~3 × chapter_count`.

| video | calls | wall time |
|---|---|---|
| 12 min | ~40 | ~2 min |
| 20 min | ~60 | ~3–5 min |
| 2 h 10 m livestream | ~390 | ~25 min |

Measured here on cogito:14b (Apple silicon): ~2.7 s/call — a 17-minute transcript ran 59 calls in
4.1 min.

## Validation results

- Livestream (2:10:46), graded against the creator's own 7-story list: 13 chapters vs an ideal ~11;
  all 7 stories present in order; a 3-way story split and two continuations consolidated correctly;
  opening, mid-stream app demo and sign-off (within 23 s of stream end) isolated.
- Placement: 64% within 5 s, 77% within 10 s of human marks; bias +0.8 s.
- Always report the no-model baseline alongside any accuracy claim: uniform spacing alone scores
  F1 0.141 @ 15 s tolerance. **A pipeline change that cannot beat the dumb baseline by a wide
  margin is noise.**

## Known limitations (open, with intended fixes)

1. **Fabricated names poison consolidation.** When a span leaves its subject unnamed, the
   summarizer can supply a famous name from its prior (deterministically, at temp 0) — and two
   summaries naming different people for the same story will refuse to merge. Intended fix, in code
   not prompts: extract proper nouns from each summary, fuzzy-match them against the span's words,
   and on a miss retry the summary with "the transcript does not mention X."
2. **Topic-similarity over-merge — the biggest open risk, and it snowballs.** The pair judge calls
   two adjacent same-theme chapters one story despite the "same broad topic is NOT enough" line.
   Because a merged chapter carries chapter A's description through the rest of the sweep (by
   design — that is what collapses a 3-way split in one pass), one bad merge makes the next
   comparison easier, and the sweep runs away.

   Measured here, cogito:14b on a 1:00:03 single-subject scholarly interview (Ehrman/Siker, "does
   the Bible condemn homosexuality"): 187 calls in 8.7 min, zero parse failures, zero placement
   fallbacks — and 7 consecutive merges took 10 chapters down to the **3-chapter floor**:

   ```
    0:00 -  4:56  Host introduces scholar Jeffrey Psyker
    4:56 - 59:13  Biblical interpretation of homosexuality      ← 54 minutes, 8 chapters eaten
   59:13 - 60:03  Podcast sign-off and channel promotion
   ```

   Every stage-4 summary on that content was a paraphrase of "biblical interpretation of
   homosexuality", so every pair genuinely *read* as one story. The intro and sign-off were
   isolated correctly; only the floor stopped it. Note the corpus mismatch: the method was sealed
   on multi-story commentary, where consecutive chapters are about different people. A long
   single-subject interview is its worst case, and this is an UNDER-split — the error class the
   user cannot fix by hand.

   Stage 2's histogram predicted it: `0=11 1=64 2=1 3=3` over 79 junctions. A rater that answers
   "1" 81% of the time has no real subject change to find, so selection degrades toward uniform
   spacing and consolidation has nothing to defend the boundaries with.

   Intended fix (from the sealed doc, NOT yet implemented — it is an unvalidated deviation): hand
   the pair judge a short transcript excerpt from each side of the seam, not just the 8-word
   summaries. A second candidate worth measuring: cap how many consecutive merges may land in one
   chapter, so a runaway sweep cannot eat an hour.
3. **Transcription proper-noun garble** both feeds fix #1 and occasionally cuts a name introduction
   off a chapter's opening — a boundary landing 4 s after "This is Eric Metaxas" leaves the span
   with an anonymous ranter.
4. **Sign-offs are isolated but sometimes mislabelled.** On the JW Broadcasting test the final 19 s
   sign-off was correctly split out but named "Opening greeting and channel intro". The boundary is
   right; the label needs an edit.
