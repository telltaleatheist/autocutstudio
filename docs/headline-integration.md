# Headline 14B — adapter deployment & integration

The integration contract for the Headline system (**headline:14b**): one shared base
model with per-task LoRA adapters that turn a video's chapter list into YouTube
titles, tags, and (soon) descriptions. This file is written to be sufficient on its
own — a fresh session on any machine (the Mac, for Auto Cut Studio integration) can
download the adapter and drive it correctly from nothing but this document.

## What exists right now

| Piece | Status | Where |
|---|---|---|
| Titles adapter (SFT v1, also handles tags + chapter naming) | **LIVE** | `owenmorgan/headline-14b-titles` on HuggingFace (private) |
| DPO-refined titles adapter | in progress | will replace the files in the SAME HF repo (SFT stays in repo git history) |
| Description + spec-compliant tags adapters | corpus being built | spec in `METADATA_SPEC.md`, evidence in `YOUTUBE_METADATA_RESEARCH.md` |
| Chaptering (the input side) | sealed | `CHAPTERING.md` in the ContentStudio repo — cogito:14b, transcript → chapter list |

- **Base model**: `Qwen/Qwen3-14B` (public HF; pulled automatically by the adapter
  config — never re-uploaded by us).
- **Auth**: the HF repo is private under the **`owenmorgan`** account (not
  telltaleatheist). On the Mac the canonical token lives at
  `~/.cache/huggingface/token`.
- Training details: 14,417 rows, CTR-tier-conditioned; best checkpoint eval_loss
  1.4016 (epoch 1); trained at `max_seq_length` 2304 with `enable_thinking=False`.

## Downloading

```python
from huggingface_hub import snapshot_download
path = snapshot_download("owenmorgan/headline-14b-titles")   # token from canonical file
```

Contains: `adapter_config.json`, `adapter_model.safetensors` (~514 MB), tokenizer
files, `README.md`. No optimizer state.

## Running

Direct PEFT/unsloth (what the audition tooling uses — see `chat_headline.py`):

```python
from unsloth import FastLanguageModel
model, tokenizer = FastLanguageModel.from_pretrained(
    "owenmorgan/headline-14b-titles", max_seq_length=2304, dtype=None, load_in_4bit=True)
FastLanguageModel.for_inference(model)
```

For ollama serving on the Mac, merge first (this repo's trainer supports
`--merge` / `save_pretrained_merged`), convert the merged model to GGUF with
llama.cpp's `convert_hf_to_gguf.py`, and register a Modelfile — the same route the
earlier `lora-titles` deployment took. Keep the chat template's thinking disabled
(see Sampling below): Qwen3 emits `<think>` blocks unless the rendered prompt
suppresses them.

## The contract: production pipeline shape

```
transcript ──cogito:14b (CHAPTERING.md)──> chapter list (the user curates/joins)
chapter list ──headline titles adapter──> title candidates (ask target: top-decile)
chapter list ──headline tags adapter────> tags            (channel tag appended by CODE)
chapter list ──headline desc adapter────> hook + body + hashtags
                                          (timestamps block + links block appended by CODE)
```

Two hard rules carried over from the chaptering law:

1. **The model never emits timestamps.** Chapter blocks in descriptions are
   assembled by code from the real chapter markers.
2. **Constant strings are appended by code, not generated** — channel name tag,
   links/promo block, anything verbatim-stable.

## Prompt format (byte-exact)

Every call is a two-message chat: a per-(task, format) **system** prompt and a
**user** turn. Render with the model's chat template, `add_generation_prompt=True`,
`enable_thinking=False`.

### User turn

```
task: title
format: normal
target: top-decile

Video:
- Subject line one
- Subject line two
- Subject line three
```

- `task`: `title` | `tags` | `chapter`
- `format`: `normal` | `livestream` (omit the line for `chapter`)
- `target`: **title task only** — `top-decile` | `strong` | `typical` | `weak`.
  This is CTR-tier conditioning: rows were labeled with the within-channel CTR
  percentile bucket their real title achieved. Production asks `top-decile`.
- After the blank line: `Video:` then the chapter list (one `- subject` per line) or
  prose. The `chapter` task uses `Chapter transcript:` instead of `Video:` followed
  by that chapter's transcript text.
- No channel name appears anywhere — deliberate; the model keys off material, not
  brand. Tiers are computed within (channel, format), so the scale stays correct
  per channel without naming it.

### System prompts (verbatim — do not paraphrase these)

`title` / `normal`:

```
You write YouTube titles for independent commentary channels covering religion, politics and the far right - the atheist, ex-religious, skeptic and left-of-centre corner of YouTube. Given a description of a video, write one title. Name names; plain concrete language, no corporate phrasing; be the prosecutor, not the journalist - state what happened and why it matters, don't hedge. Specificity plus an open loop beats vague drama. This is a standard upload: the hook lands inside the first 45 characters and the whole title runs 45-70 characters, covering one story.
```

`title` / `livestream`:

```
You write YouTube titles for independent commentary channels covering religion, politics and the far right - the atheist, ex-religious, skeptic and left-of-centre corner of YouTube. Given a description of a video, write one title. Name names; plain concrete language, no corporate phrasing; be the prosecutor, not the journalist - state what happened and why it matters, don't hedge. Specificity plus an open loop beats vague drama. This is a livestream and the description lists the separate stories it worked through. Pick the one story with the strongest hook and write the title to that; naming two or three is acceptable only when no single story carries it. Run 45-90 characters.
```

`tags` (same for both formats):

```
You write YouTube tags for independent commentary channels covering religion, politics and the far right. Given a description of a video, write a comma-separated list of tags: the specific people, organizations and events it covers, plus the broad topics it belongs to. No channel names and no creator names - those are appended separately.
```

`chapter`:

```
You write YouTube chapter lines. Given the transcript of one chapter of a video, write a single line naming what happens in it. Name names, stay concrete, no hedging and no preamble - the line stands on its own in a list of chapters. Do not include a timestamp.
```

(A `description` task system prompt exists in the training data but that task has
only a placeholder row in v1 — do not use it until the description adapter ships.)

## Sampling

- **Titles**: `do_sample=True, temperature=0.7, top_p=0.9`, generate 3-6 candidates,
  surface them for the user to pick. `max_new_tokens=64` is plenty.
- **Tags / chapter lines**: greedy (`do_sample=False`), one generation.
- Always `enable_thinking=False` in the chat-template kwargs — the adapter was
  trained with thinking off; letting Qwen3 think changes the distribution and wastes
  tokens.

## Known behavior / caveats

- **Tier conditioning is real and visible**: the same input at `target: weak` yields
  flat literal titles; at `top-decile` it reaches for the concrete hook (audition:
  "Norway Just Paid JWs $1.7M to Shun People" vs the real title "Norway Pays
  Jehovah's Witnesses $1.7M to Shun Kids").
- **Fabrication rate ~1 in 8-16 sampled titles**: occasionally inserts a specific
  (a dollar figure, "third loss") not present in the input. Surface multiple
  candidates and let the user pick; never auto-publish a title unreviewed. The DPO
  stage targets exactly this.
- Input spellings pass through: if the chapter list carries an ASR misspelling, the
  title will too. Correct behavior — fix the chapter list, not the model.
- The tags task in THIS adapter reproduces the historical tag style. The
  spec-compliant tags adapter (see `METADATA_SPEC.md`) will replace it.

## Auditioning

`chat_headline.py` in this repo is a terminal REPL against any checkpoint or the HF
repo; it lifts system prompts from the training JSONL so sessions match training
byte-for-byte. Windows one-liner in its docstring.
