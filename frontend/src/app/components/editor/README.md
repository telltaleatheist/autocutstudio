# Timeline editor

Everything the timeline editor is made of, in one folder:

- `editor.component.*` — the shell (timeline, transcript, playback, chapters, story).
- `editor.module.ts` — declares and exports all six editor components, provides
  `ProjectsService`. The host app imports this module; the router gets
  `EditorComponent` through its exports.
- `model/` — pure helpers (types, math, formatting, story utils), no Angular.
- `timeline/` — canvas renderer, scene building, metrics, waveform cache.
- `activity-dock/`, `export-modals/`, `transcript-pane/` — child components.
- `project-sidebar/`, `project-setup-modal/` — the projects layer (list, drag/drop,
  settings + Process).
- `services/projects.service.ts` — projects registry CRUD, folder scan/classify,
  current project. Used only from this folder.
- `styles/_modal.scss` — shared modal partial, `@use`d by the components here.

## Portability

This folder is meant to be copied wholesale into another Angular app (Content
Studio). Nothing outside it imports anything inside it except
`app.module.ts` (imports `EditorModule`) and `app-routing.module.ts` (routes to
`EditorComponent`).

What it still needs from the host:

- `src/app/models/editor-manifest` — the manifest/segment/track types.
- `src/app/services/electron.service` — IPC bridge.
- `src/app/services/processing.service` — job lifecycle, progress, console.
- `src/app/services/workflow-payload` — the shared workflow payload builder
  (deliberately shared with `components/workflow`; it is the narrow seam to the
  Python workflow).

Step B of the portability work replaces those service dependencies with a single
injected host port, so the folder can be dropped into a host that implements the
port however it likes. Until then, a copy of this folder must be accompanied by
the four modules listed above.
