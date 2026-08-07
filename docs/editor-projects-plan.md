# Plan: projects in the editor (FCPX-library-style), and alignment accuracy

Written 2026-08-06. Two independent workstreams; the second does not block the
first.

---

## Part A — Move workflow processing into the editor

### Goal

A project is a **session folder on disk**. The editor gets a left-hand sidebar
listing known projects, the way FCPX lists libraries. Drop a folder in (or add
one), click it, pick settings in a modal, hit Process, watch the progress bar in
that modal, and the editor opens on the result. Previously processed projects on
disk are listed and switched to by clicking.

### What already exists and should not be rebuilt

- `auto-detect-audio` (ipc-handlers.ts) already infers every source from the
  master filename — this is what pre-populates the settings modal.
- `processing.service.ts` already owns job lifecycle, progress, console output,
  skip signals. The modal is a new *view* of it, not a new mechanism.
- `execute-workflow` passes the whole options object to Python verbatim
  (`JSON.stringify(options.inputData)`), so no IPC changes are needed for
  anything the workflow component already sends.
- The editor already has a session-reset path (used when loading a new session);
  project switching must go through it rather than inventing a second one.

### Project state model

A folder is classified by what it contains, from a single scan:

| state | evidence on disk |
|---|---|
| `raw` | master + companions, no `_compounds.zip` |
| `processed` | `<session>_compounds.zip` present |
| `edited` | `<session>_edits.json` present |
| `missing` | registry entry whose folder no longer exists |

The session prefix is derived exactly as `auto-detect-audio` does (strip a
trailing ` master` from the master video's filename). One scan function must be
the single source of truth for this — do not re-derive the prefix in the UI.

`missing` is a state, not a reason to drop the entry: a folder on an unmounted
volume must come back when the volume returns, so the registry keeps it and the
sidebar greys it.

### Registry

`projects.json` in `AUTOCUT_CONFIG_DIR` (the directory the Settings UI already
writes to — resolve it the same way `core/drift_config.py` does, never assume).

```jsonc
{ "version": 1,
  "projects": [ { "path": "...", "name": "2026-08-05", "lastOpened": "ISO" } ] }
```

Rules: adding an existing path is a no-op (dedupe by realpath, not by string);
a corrupt registry raises and is surfaced, never silently reset — losing a
user's project list to a parse error is exactly the kind of silent failure this
codebase refuses elsewhere.

### Structure

Do **not** put this in `editor.component.ts` — it is already very large.

- `ProjectsService` (frontend): registry CRUD, scan/classify, current project.
- `ProjectSidebarComponent`: the list, drag/drop target, state badges.
- `ProjectSetupModalComponent`: settings + Process + progress, driven by
  `processing.service`.
- A shell component owns sidebar + editor; the editor keeps its current inputs.

New IPC needed (small): `scan-project-folder` (classify a folder), and
`read/write-projects-registry`. Folder drag/drop gives a path in Electron via
`webUtils.getPathForFile` — plain `File.path` is removed in Electron 32.

### Phasing

1. Registry + sidebar + switching between **already-processed** projects. This
   alone is useful and touches no processing code.
2. Settings modal driven by `auto-detect-audio`, Process button, progress. Runs
   the same payload the workflow component builds today — factor that payload
   construction out of `workflow.component.ts` so there is one builder, not two
   that will drift apart.

The existing standalone workflow screen **stays**. It becomes redundant, not
removed; leaving it costs nothing and keeps a working path available while the
modal beds in.

### Portability constraint (stated 2026-08-06)

The editor is expected to be lifted out of AutoCutStudio and re-hosted in
**Content Studio** later. That is not current work, but it sets a direction for
this one: build the projects layer so it can travel.

- Keep the projects layer's dependency on AutoCutStudio one-directional. The
  sidebar/registry/scan should know about *session folders*, not about compound
  generators or the Python workflow.
- Reaching the workflow goes through ONE narrow seam (the shared payload builder
  plus `processing.service`), so re-hosting means replacing that seam rather
  than unpicking the UI.
- Keep new IPC small and explicitly named (`scan-project-folder`,
  `read/write-projects-registry`). Every added channel is something the future
  host has to reimplement.
- Do not thread editor state through AutoCutStudio-specific services just
  because they are convenient today.

### Watch out for

- **One job at a time.** `processing.service` assumes a single current job. Either
  enforce it in the UI (disable Process while one runs) or make the job map
  project-keyed. Decide before phase 2, not during.
- **A running job must survive the modal closing.** Progress lives in the
  service; the modal only renders it.
- **Project switch during a run** must be refused or must abort the run
  explicitly. Silently switching while Python writes into the old folder is the
  worst outcome.
- The split-capture fields (`videoContinuations`, `videoSeamGaps`) must ride
  along in the shared payload builder.

---

## Part B — Alignment accuracy

### Findings (measured 2026-08-05/06, not assumed)

- **Audio alignment is not the problem.** GCC-PHAT resolves to ~0.03 ms; real
  sources measured at confidence 0.95–0.99 with **0.0 ms spread** across windows
  spanning 3+ hours. Nothing meaningful left to gain.
- **Video clips are placed by their AUDIO, but their PICTURE is what must line
  up.** 2026-08-05 part 1: audio at +0.0060 s with zero drift, picture 2–6
  frames earlier and drifting ~10 frames across 3 h 13 m.
- **Measured drift is discarded.** `measure_offset` returns
  `drift_seconds_est`; nothing consumes it. `video_drift_factors` is populated
  only from explicit manual overrides (`electron_workflow.py`), so every session
  otherwise gets the hardcoded `vmix_sources` `0.9999763884`. That session's
  screen capture actually measured ≈ `0.999972`.

### Proposed work

1. **Per-session picture offset for video sources.** Use
   `core.video_align.scene_change_offset` (validated to **0.54 frames** against
   audio ground truth on 2026-08-02, 128 matched cut pairs) against the master
   cropped to the source's quadrant. Head-of-session measurement becomes the
   placement offset.
2. **Per-session drift factor.** Head vs tail picture offset gives the slope;
   feed it through the existing `driftFactor` → `calculate_retime_map(
   speed_factor=...)` path, which already works. Fall back to the config
   constant only when cut matching cannot answer, and say which was used.
3. **Report picture-vs-audio disagreement loudly.** When a video source's
   picture and audio offsets differ by more than a frame or two, that is a
   damaged recording and the user should be told, not silently given the audio
   answer.
4. **Close the silent fallback.** `electron_workflow.py`'s video-offset loop
   catches any measurement failure and stores `0.0` — a wrong-but-plausible
   placement. It should mark the source untrusted or fail.

Sequence 4 → 1 → 3 → 2. Item 4 is small and independent; item 2 is the one that
needs the most care, since a bad measured drift factor is worse than a
mediocre constant one, so it must be gated on the same agreement evidence the
seam measurement uses.

### Cost note

Cut matching decodes a couple of windows of the master per source. On the
2026-08-05 session (66 GB master) a 2400 s span took roughly a minute. Acceptable
once per source per session; do not run it per window.
