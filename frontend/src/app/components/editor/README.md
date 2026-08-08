# Timeline editor

Everything the timeline editor is made of, in one folder:

- `editor.component.*` — the shell (timeline, transcript, playback, chapters, story).
- `editor.module.ts` — declares and exports all six editor components, provides
  `ProjectsService`. The host app imports this module; the router gets
  `EditorComponent` through its exports.
- `editor-host.ts` — **the port**: the `EditorHost` interface and the `EDITOR_HOST`
  injection token. See below.
- `model/` — pure helpers (types, math, formatting, story utils), no Angular.
- `timeline/` — canvas renderer, scene building, metrics, waveform cache.
- `activity-dock/`, `export-modals/`, `transcript-pane/` — child components.
- `project-sidebar/`, `project-setup-modal/` — the projects layer (list, drag/drop,
  settings + Process).
- `services/projects.service.ts` — projects registry CRUD, folder scan/classify,
  current project. Used only from this folder.
- `styles/_modal.scss` — shared modal partial, `@use`d by the components here.

## The host port

Nothing in this folder talks to the host application directly. Everything —
session payload, edit state, transcription, story analysis, waveform peaks, file
dialogs, the projects registry, processing jobs — goes through the single
`EditorHost` interface in `editor-host.ts`, injected via `EDITOR_HOST`.

**To re-host this editor: copy this folder, implement `EditorHost`, and bind it in
the host's root module** (`{ provide: EDITOR_HOST, useClass: YourAdapter }`).
`EditorModule` deliberately does not provide the token, so this tree contains no
reference to any implementation. AutoCutStudio's implementation lives outside the
folder, at `src/app/services/editor-host.adapter.ts`.

`sendSubjectsToTitles` is optional — it is AutoCutStudio's Metadata-tab handoff. A
host that omits it gets a clear message in the editor's transport-error line, never
a Send button that silently does nothing.

## Remaining shared surface

Three imports still reach outside this folder. They are data/format, not host
capability, and are the next thing to fold in if the copy has to be truly clean:

- `src/app/models/editor-manifest` — manifest/segment/track types.
- `src/app/models/types` — media-source enums used by the setup modal.
- `src/app/services/workflow-payload` — the shared payload builder, deliberately
  shared with `components/workflow` as the narrow seam to the Python workflow.
