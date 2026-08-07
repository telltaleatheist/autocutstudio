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
   alone is useful and touches no processing code. ✅ **Built 2026-08-07**:
   `projects:read-registry` / `projects:write-registry` / `projects:scan-folder`
   IPC (registry at `$AUTOCUT_CONFIG_DIR/projects.json`, corrupt file throws and
   is never overwritten), `ProjectsService` (realpath dedupe, one-time migration
   of `editor.recentSessions`), `ProjectSidebarComponent` replacing the editor's
   recents pane (state badges, drag/drop, + button, File→Add Project…).
2. Settings modal driven by `auto-detect-audio`, Process button, progress. Runs
   the same payload the workflow component builds today — factor that payload
   construction out of `workflow.component.ts` so there is one builder, not two
   that will drift apart. ✅ **Built 2026-08-07**: shared builder
   `frontend/src/app/services/workflow-payload.ts` (used by both surfaces),
   `ProjectSetupModalComponent` (Detect pre-fill, editable rows, autoDuck /
   useDownloadedStream / denoiseMics toggles, live progress + console + skip +
   in-modal cancel; closing never cancels; terminal job triggers a rescan so a
   closed modal can't leave a stale badge). Not yet exercised in the running app.
   Known wart: `processing.service` still pops its legacy `alert()` on job
   failure, so a failed modal run shows both that alert and the inline error.

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

### Done (2026-08-07)

1. **Per-session picture offset for video sources.** ✅ Every video source is now
   placed by its PICTURE. `core.video_align.locate_by_picture` is the public
   entry point — cut matching first, motion correlation as the fallback — against
   the master cropped to that source's quadrant. The splice's seam measurement
   and the per-session placement now go through the same function, so there is
   one implementation, not two.
3. **Report picture-vs-audio disagreement loudly.** ✅ Audio is still measured,
   but as an independent cross-check rather than the answer. A gap over
   `PICTURE_AUDIO_DISAGREEMENT_FRAMES` (2) is reported as a damaged recording,
   and both numbers plus the disagreement land in the alignment sidecar.
4. **Close the silent fallback.** ✅ `_measure_video_offset` raises when neither
   picture nor audio can answer. It used to store `0.0`, which puts a clip
   exactly where an unmeasured clip lands — undetectable downstream.

Two things surfaced while doing it:

- **A source with no audio stream could not be picture-aligned at all.**
  `video_align` sized its windows with `audio_processor.get_duration_seconds`,
  which reads the *audio* stream and raises when there is none — refusing at the
  door exactly the game captures picture alignment exists for. Replaced with
  `video_align.video_duration` (ffprobe on the video stream).
- **A 900 s window is marginal on real material.** On 2026-08-05 the head
  yielded exactly the 6-pair minimum and the pre-seam window only 5. Cut
  matching now escalates once to a 3× wider span before dropping to motion
  correlation.

### Still to do

2. **Per-session drift factor.** Head vs tail picture offset gives the slope;
   feed it through the existing `driftFactor` → `calculate_retime_map(
   speed_factor=...)` path, which already works. Fall back to the config
   constant only when cut matching cannot answer, and say which was used. This
   is the one that needs the most care — a bad measured drift factor is worse
   than a mediocre constant one, so it must be gated on the same agreement
   evidence the seam measurement uses. `measure_offset`'s `drift_seconds_est` is
   still computed and still consumed by nobody.

### Cost note

Cut matching decodes a window of the master per source, plus a 3× wider one when
the first is too static. On the 2026-08-05 session (66 GB master) a 2400 s span
took a few minutes. Acceptable once per source per session; do not run it per
window. If this becomes the bottleneck, the master's four quadrants can be
scene-detected in a single pass with `split` rather than one pass per source.
