// electron/ipc/ipc-handlers.ts
import { ipcMain, dialog, shell } from 'electron';
import { spawn } from 'child_process';
import * as log from 'electron-log';
import { WindowService } from '../services/window-service';
import { PythonService } from '../services/python-service';
import { DependencyService } from '../services/dependency-service';
import { DuganAutomixer, DuganTrack } from '../services/dugan-automixer';
import { BinaryResolver } from '../services/binary-resolver';
import { AlignmentAudioService } from '../services/alignment-audio-service';
import { AppConfig } from '../config/app-config';
import * as assetManager from '../services/asset-manager';
import * as ollamaService from '../services/ollama-service';
import { analyzeChapters, suggestTitle, Segment } from '../services/chapter-splitter';
import * as titleGenerator from '../services/title-generator';
import { AIManagerService, AIConfig } from '../services/metadata/ai-manager.service';
import type { ContentItem } from '../services/metadata/input-handler.service';
import {
  parseTranscriptImport,
  wordsToSegments,
  buildTranscriptSlices,
  TranscriptSliceCut,
} from '../services/metadata/transcript-import.service';
import { EpisodeSplitterService } from '../services/metadata/episode-splitter.service';
import { saveTitleReport, TitleReport } from '../services/metadata/title-report.service';
import type { ChapterPipelineResult } from '../services/metadata/chapter-pipeline.service';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let pythonService: PythonService;
let dependencyService: DependencyService;

// ==================== METADATA PIPELINE STATE ====================
// Ported from ContentStudio's electron/ipc/ipc-handlers.ts, where this state also lived at
// module scope. It stays at module scope here for the same reason plus one more: the shared
// 'cancel-job' channel (registered in setupPythonHandlers) has to reach it.

/** Metadata jobs the renderer can cancel by id. */
const metadataRunningJobs = new Map<string, { cancel: () => void }>();

// ==================== "SHOW PROMPT" HELD TRANSCRIPTS ====================
// When a job runs with showPrompt=true we transcribe + assemble the prompt but STOP
// before the AI call, holding the transcription result (ContentItem[]) here keyed by
// jobId. "Send to AI" (send-held-prompt) then re-runs generation against this SAME
// transcript via preTranscribedContent — NO re-transcription. Transcripts are NOT
// otherwise cached (the pipeline transcribes to a temp dir and deletes it), so this
// map is the only place the result survives between the two IPC calls.
//
// Lifecycle: entries are removed on send (success), discard, or job cancel/removal.
// There is no timer — the frontend MUST send or discard, and cancel/removal is a
// safety net. Practically bounded by the number of pending queue items.
const heldTranscripts = new Map<string, {
  contentItems: ContentItem[];
  metadataParams: any;
  // Chapters the show-prompt assembly already paid for. They are part of the
  // prompt the user is looking at, so "Send to AI" must send THOSE chapters,
  // not a fresh pipeline run that could land its boundaries somewhere else.
  computedChapters?: { [sourceLabel: string]: ChapterPipelineResult };
}>();

/**
 * Cancel a metadata job: stop the run if one is live, and drop any held "Show prompt"
 * transcript so cancelling can't leak the held ContentItem[].
 *
 * Returns whether anything was actually cancelled, so callers can tell "cancelled" from
 * "no such job" rather than reporting success for an id nobody has ever seen.
 *
 * Shared by BOTH channels that can cancel metadata work — 'metadata:cancel-job' and the
 * merged 'cancel-job' — so the two can never drift apart.
 */
function cancelMetadataJob(jobId: string): boolean {
  // Deleted first because a held job has no entry in metadataRunningJobs at all.
  const hadHeld = heldTranscripts.delete(jobId);

  const job = metadataRunningJobs.get(jobId);
  if (job) {
    log.info(`[IPC] Cancelling metadata job: ${jobId}`);
    job.cancel();
    metadataRunningJobs.delete(jobId);
    return true;
  }

  if (hadHeld) {
    log.info(`[IPC] Dropped held prompt for job: ${jobId}`);
    return true;
  }

  return false;
}

/**
 * Set up all IPC handlers
 */
export function setupIpcHandlers(windowService: WindowService, pythonSvc: PythonService, depService: DependencyService): void {
  pythonService = pythonSvc;
  dependencyService = depService;

  setupFileSystemHandlers(windowService);
  setupDependencyHandlers();
  setupAudioHandlers();
  setupPythonHandlers();
  setupUtilityHandlers();
  setupConfigHandlers();
  setupAssetHandlers(windowService);
  setupAlignmentHandlers(windowService);
  setupEditorHandlers(windowService);
  setupStoryAnalysisHandlers();
  setupTitleHandlers(windowService);
  setupMetadataHandlers(windowService);
  setupProjectHandlers();
}

/**
 * Story-analysis handlers: local-LLM (Ollama) chapter splitting + title
 * suggestions for Story Mode. All synchronous request/response — the renderer
 * holds the transcript and passes the relevant segments in; the main process
 * only runs the LLM call + phrase→timestamp mapping. Failures reject with the
 * real error (Ollama down, empty response, unparseable) — never a fabricated
 * result.
 */
function setupStoryAnalysisHandlers(): void {
  // The single in-flight analysis (chapter split OR title suggestion). Only one runs at a time —
  // the renderer gates on `analyzing`/`splitRunning` — so one controller is enough. 'story:cancel'
  // aborts it, which kills the HTTP request and unwinds the pipeline loop on the next check.
  let activeRun: AbortController | null = null;

  // List locally-installed Ollama models (for the model picker).
  ipcMain.handle('ollama:list-models', async (_event, payload?: { host?: string }) => {
    return ollamaService.listModels(payload?.host);
  });

  // Stop whatever analysis is running. Safe to call when nothing is — returns `stopped: false`
  // rather than throwing, so a stale click from a closed dialog is harmless.
  ipcMain.handle('story:cancel', async () => {
    if (!activeRun) return { stopped: false };
    log.info('[Story] cancel requested — aborting the in-flight analysis');
    activeRun.abort();
    return { stopped: true };
  });

  // Split a span of transcript into consecutive subject chapters. The pipeline is many small
  // single-question calls (~40 for a 12-minute video, ~390 for a 2-hour livestream), so step
  // progress is streamed back to the calling renderer on 'story:analyze-progress'. The model is
  // unloaded afterwards — a 14B left resident after a 25-minute run is memory nobody asked for.
  ipcMain.handle(
    'story:analyze-chapters',
    async (event, payload: { segments: Segment[]; model: string; host?: string; consolidate?: boolean }) => {
      const { segments, model, host, consolidate } = payload || ({} as any);
      if (!Array.isArray(segments) || segments.length === 0) {
        throw new Error('No transcript segments provided for chapter analysis.');
      }
      const controller = new AbortController();
      activeRun = controller;
      const generate = (prompt: string, opts?: ollamaService.GenerateOptions) =>
        ollamaService.generate(model, prompt, { host, signal: controller.signal, ...opts });
      const onProgress = (p: { phase: string; done: number; total: number }) => {
        if (!event.sender.isDestroyed()) event.sender.send('story:analyze-progress', p);
      };
      try {
        // `consolidate` is forwarded, NOT defaulted here — chapter-splitter owns the default (true).
        // The renderer sends false when the span is a story it has already defined, where stage 5
        // can only produce false merges. Defaulting in two places is how the two drift apart.
        const chapters = await analyzeChapters(
          segments, model, generate, onProgress, controller.signal, { consolidate }
        );
        return { chapters };
      } finally {
        if (activeRun === controller) activeRun = null;
        // Unloaded on a stop too — a stopped run has no more claim on the memory than a finished
        // one, and stopping is usually how a user reacts to the machine being busy.
        await ollamaService.unload(model, host);
      }
    }
  );

  // Suggest a single title for a story's transcript text. NOT unloaded afterwards — titling runs
  // once per story in a tight loop, and evicting between them would reload the model every time.
  // The renderer unloads once when its loop ends (or is stopped) via 'story:unload-model'.
  ipcMain.handle(
    'story:suggest-title',
    // `text` is either transcript text or a story's chapter labels. A subject list is the better
    // input — no truncation, and it is the shape the eventual titling adapter conditions on — so
    // the type must admit it rather than let an array cross a `string` boundary unremarked.
    async (_event, payload: { text: string | string[]; model: string; host?: string }) => {
      const { text, model, host } = payload || ({} as any);
      const controller = new AbortController();
      activeRun = controller;
      const generate = (prompt: string, opts?: ollamaService.GenerateOptions) =>
        ollamaService.generate(model, prompt, { host, signal: controller.signal, ...opts });
      try {
        const title = await suggestTitle(text, generate);
        return { title };
      } finally {
        if (activeRun === controller) activeRun = null;
      }
    }
  );

  // Evict a model the renderer is done with (end of a titling loop, or a stop). Never throws.
  ipcMain.handle('story:unload-model', async (_event, payload: { model: string; host?: string }) => {
    const { model, host } = payload || ({} as any);
    await ollamaService.unload(model, host);
    return { ok: true };
  });
}

/** One story's subject list on its way to the Metadata page. The wire carries a batch of these.
 *
 *  `chapters` (optional) is that story's chapter list with times relative to the story's OWN
 *  exported video. It is carried for the SAVED TITLE REPORT only: the titling model sees
 *  `subjects` and nothing else, and no timestamp is ever folded into them (the
 *  headline-integration contract strips clocks in code). Nothing on this path may join the two. */
type TitleHandoff = {
  subjects: string[];
  format: titleGenerator.TitleFormat;
  source?: string;
  chapters?: { timestamp: string; title: string }[];
};

/**
 * Titles tab handlers — YouTube title suggestions from a subject list, via the local
 * fine-tuned `headline-14b-titles` model. See services/title-generator.ts for the model
 * contract (it is byte-exact and not negotiable here).
 *
 * Two independent jobs live in this block:
 *
 *  1. Generation ('titles:generate' / 'titles:cancel' / 'titles:unload'). Ten separate
 *     chat completions per run, streamed back to the CALLING renderer on 'titles:progress'
 *     so suggestions appear as they land. Any Ollama failure — model missing, daemon down,
 *     empty completion — rejects with the real message. Nothing is fabricated and no other
 *     model is substituted.
 *
 *  2. The editor → Titles-tab handoff ('titles:send-subjects' / 'titles:take-pending').
 *     The timeline editor runs in its OWN window, so a story's chapter list cannot be
 *     handed over in-process. The editor pushes it here; the main window is focused and
 *     given it on 'titles:subjects', and the payload is ALSO parked for a race-free pull
 *     — the same belt-and-suspenders shape as the editor's own seed payload.
 *
 *     The park is a QUEUE, not a slot: the editor can send several stories at once (each
 *     one its own handoff, because each becomes its own upload), and a second send that
 *     lands before the tab drains the first must not overwrite it.
 */
function setupTitleHandlers(windowService: WindowService): void {
  let activeRun: AbortController | null = null;
  let pendingHandoffs: TitleHandoff[] = [];

  ipcMain.handle('titles:cancel', async () => {
    if (!activeRun) return { stopped: false };
    log.info('[Titles] cancel requested — aborting the in-flight run');
    activeRun.abort();
    return { stopped: true };
  });

  ipcMain.handle(
    'titles:generate',
    async (
      event,
      payload: {
        text: string;
        format: titleGenerator.TitleFormat;
        target: titleGenerator.TitleTarget;
        count?: number;
        model?: string;
        host?: string;
      }
    ) => {
      const { text, format, target } = payload || ({} as any);
      const model = payload?.model || titleGenerator.TITLE_MODEL;
      // The title model does not live on the shared Ollama daemon — see TITLE_HOST in
      // services/title-generator.ts for why it is served on its own port. An explicit
      // `host` in the payload still wins, so a caller can aim a run anywhere.
      const host = payload?.host || titleGenerator.TITLE_HOST;
      const count = payload?.count ?? 10;

      if (format !== 'normal' && format !== 'livestream') {
        throw new Error(`titles:generate format must be 'normal' or 'livestream', got: ${format}`);
      }
      if (!titleGenerator.TITLE_TARGETS.includes(target)) {
        throw new Error(
          `titles:generate target must be one of ${titleGenerator.TITLE_TARGETS.join(' | ')}, got: ${target}`
        );
      }
      // Parsing lives in the main process so the stripping rules (bullets, clocks) have exactly
      // one implementation, and so the UI can show the user the lines the model actually saw.
      const subjects = titleGenerator.parseSubjects(text);
      if (subjects.length === 0) {
        throw new Error('No subject lines found — paste the video’s chapters, one per line.');
      }

      const controller = new AbortController();
      activeRun = controller;
      const chat = (messages: ollamaService.ChatMessage[], opts?: ollamaService.ChatOptions) =>
        ollamaService.chat(model, messages, { host, signal: controller.signal, ...opts });

      try {
        const { titles } = await titleGenerator.generateTitles({
          subjects,
          format,
          target,
          count,
          chat,
          signal: controller.signal,
          onProgress: (p) => {
            if (!event.sender.isDestroyed()) event.sender.send('titles:progress', p);
          },
        });
        return { titles, subjects, model };
      } finally {
        if (activeRun === controller) activeRun = null;
      }
    }
  );

  // Evict the title model. Called when the user leaves the tab — a 14B is ~9 GB and the
  // machine should get it back. Best-effort by design (unload never throws).
  ipcMain.handle('titles:unload', async (_event, payload?: { model?: string; host?: string }) => {
    await ollamaService.unload(
      payload?.model || titleGenerator.TITLE_MODEL,
      payload?.host || titleGenerator.TITLE_HOST
    );
    return { ok: true };
  });

  // ── Editor → Titles handoff ────────────────────────────────────────────────
  ipcMain.handle(
    'titles:send-subjects',
    async (
      _event,
      payload: {
        handoffs: {
          subjects: string[];
          format?: titleGenerator.TitleFormat;
          source?: string;
          chapters?: { timestamp: string; title: string }[];
        }[];
      }
    ) => {
      const incoming = payload?.handoffs;
      if (!Array.isArray(incoming) || incoming.length === 0) {
        throw new Error('titles:send-subjects requires a non-empty handoffs array');
      }
      // Validated in full BEFORE anything is parked or pushed, so a bad batch cannot leave half
      // of itself queued for a tab that will then show stories the sender was told never went.
      const batch: TitleHandoff[] = incoming.map((h, i) => {
        const from = h?.source ? ` (“${h.source}”)` : '';
        const subjects = h?.subjects;
        if (!Array.isArray(subjects) || subjects.length === 0) {
          throw new Error(`titles:send-subjects handoff at index ${i}${from} has a missing or empty subjects array`);
        }
        const bad = subjects.findIndex((s) => typeof s !== 'string');
        if (bad !== -1) {
          throw new Error(`titles:send-subjects handoff at index ${i}${from}: subject at index ${bad} is not a string`);
        }
        // Chapters are OPTIONAL (the editor's title-only fallback sends none), but a malformed
        // list rejects the WHOLE batch like everything else here: half a chapter list saved into
        // a title report is a record that lies about the video it names.
        const chapters = h?.chapters;
        if (chapters !== undefined) {
          if (!Array.isArray(chapters)) {
            throw new Error(`titles:send-subjects handoff at index ${i}${from}: chapters is not an array`);
          }
          chapters.forEach((c, j) => {
            const ok = (v: any) => typeof v === 'string' && v.trim().length > 0;
            if (!c || typeof c !== 'object' || !ok(c.timestamp) || !ok(c.title)) {
              throw new Error(
                `titles:send-subjects handoff at index ${i}${from}: chapter at index ${j} needs a ` +
                `non-empty timestamp and title`
              );
            }
          });
        }
        return {
          subjects,
          format: h?.format === 'livestream' ? 'livestream' : 'normal',
          source: h?.source,
          // Passed through untouched — this never reaches the model, only the saved report.
          ...(chapters !== undefined ? { chapters } : {}),
        };
      });

      const main = windowService.getMainWindow();
      if (!main || main.isDestroyed()) {
        // The only window that hosts the Titles tab is gone. Say so — the user pressed a
        // button and is owed an answer, not a payload parked for a window that will not return.
        // Checked before the append for the same reason: parking then throwing leaves a ghost
        // batch that the next tab visit would deliver as if the send had succeeded.
        throw new Error('The main AutoCutStudio window is closed — reopen it to use the Titles tab.');
      }
      pendingHandoffs = [...pendingHandoffs, ...batch];
      // The push carries the WHOLE queue, not just this batch: it is exactly what a tab pulling
      // instead would get, so a receiver can treat push and pull as the same delivery.
      main.webContents.send('titles:subjects', pendingHandoffs);
      windowService.focusWindow();
      return { success: true };
    }
  );

  // Race-free pull for a Titles tab that mounts after the push (or was never listening).
  // Draining empties the queue: a handoff is delivered once, not replayed on every visit.
  // Always an array — an empty one means nothing was waiting, which is not an error.
  ipcMain.handle('titles:take-pending', async () => {
    const taken = pendingHandoffs;
    pendingHandoffs = [];
    return taken;
  });
}

/**
 * View-only timeline editor handlers.
 *
 * Same cross-window seed-payload pattern as the alignment wizard, but DELIBERATELY
 * simpler and with its OWN state: the main window invokes 'editor:open' with a
 * { zipPath } payload; the main process opens/focuses the single editor window on
 * the '/editor' route and holds the payload until the editor pulls it via
 * 'editor:get-payload' (race-free) — it is ALSO pushed on did-finish-load. A call
 * with NO zipPath (the side-nav Editor button) opens/focuses the window with no
 * session: the editor mounts on its empty state and the user picks a project
 * in-window. There is
 * NO completion relay and NO settle guard: the editor is view-only, so closing its
 * window is not a decision the main window is waiting on. This state never touches
 * the alignment wizard's pendingPayload/settled/relay logic.
 *
 * 'editor:manifest' runs PythonService.editorManifest and returns the flattened
 * timeline manifest; a Python failure rejects with the Python message VERBATIM —
 * a manifest is never fabricated.
 */
function setupEditorHandlers(windowService: WindowService): void {
  // Editor-scoped seed payload, independent of the alignment wizard's state.
  let pendingEditorPayload: { zipPath: string } | null = null;

  ipcMain.handle('editor:open', async (_event, payload?: { zipPath?: string | null }) => {
    try {
      const zipPath = payload?.zipPath ?? null;
      if (zipPath !== null && (typeof zipPath !== 'string' || zipPath.trim() === '')) {
        throw new Error('editor:open zipPath must be a non-empty string when provided');
      }
      if (zipPath !== null && !fs.existsSync(zipPath)) {
        throw new Error(`editor:open zip file does not exist: ${zipPath}`);
      }

      // The single secondary window may currently host the alignment wizard; a
      // mid-flight wizard must not be silently hijacked (the workflow page is
      // awaiting its completion relay, which would never fire). Refuse loudly.
      const existing = windowService.getEditorWindow();
      const existingUrl = existing && !existing.isDestroyed() ? existing.webContents.getURL() : '';
      if (existingUrl.endsWith('#/alignment')) {
        throw new Error('The manual-alignment wizard is open. Finish or cancel it before opening the editor.');
      }
      const alreadyOnEditor = existingUrl.endsWith('#/editor');

      // Blank open (no zipPath): the side-nav Editor button. An already-open editor is
      // simply focused — whatever session it holds stays loaded, and the stale pending
      // payload is left alone (an open window never re-pulls it). A fresh window must
      // NOT inherit a previous session's payload, so the pending slot is cleared and
      // the editor mounts on its no-session state (projects sidebar, empty workspace).
      if (zipPath === null) {
        if (!alreadyOnEditor) {
          pendingEditorPayload = null;
        }
        windowService.createEditorWindow('/editor');
        return { success: true };
      }

      pendingEditorPayload = { zipPath };

      const win = windowService.createEditorWindow('/editor');

      if (alreadyOnEditor) {
        // Already mounted on /editor — no navigation, so no did-finish-load will
        // fire. Push the new payload now; the mounted component re-initializes.
        win.webContents.send('editor-payload', pendingEditorPayload);
      } else {
        // Fresh window: push once loaded (belt-and-suspenders; the editor also
        // pulls via 'editor:get-payload' so there is no delivery race).
        win.webContents.once('did-finish-load', () => {
          if (!win.isDestroyed()) {
            win.webContents.send('editor-payload', pendingEditorPayload);
          }
        });
      }

      return { success: true };
    } catch (error: any) {
      log.error('editor:open failed:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });

  // Race-free pull of the seed payload by the editor renderer on mount.
  ipcMain.handle('editor:get-payload', async () => {
    return pendingEditorPayload;
  });

  // Build the view-only timeline manifest from the session zip. Rejections
  // propagate the Python error message verbatim; the manifest is never faked.
  ipcMain.handle('editor:manifest', async (_event, payload: { zipPath: string }) => {
    const zipPath = payload?.zipPath;
    if (typeof zipPath !== 'string' || zipPath.trim() === '') {
      throw new Error('editor:manifest requires a non-empty zipPath string');
    }
    return await pythonService.editorManifest(zipPath);
  });

  // Apply a list of frame-range cuts and write a revised .fcpxml next to the zip.
  // Validate loudly per the cut contract before spawning Python: a bad payload is
  // a caller bug, never a silent no-op. Rejections propagate the Python error
  // message verbatim; the export result is never fabricated.
  ipcMain.handle('editor:export', async (_event, payload: {
    zipPath: string;
    cuts: Array<{ startFrame: number; endFrame: number }>;
    stories?: Array<{ number: number; title: string; regions: Array<{ start: number; end: number }> }>;
    output?: 'fcpxml' | 'transcripts';
    // Split every mic lane where the screen track speaks and the mic does not, and disable
    // the middle pieces. Must be forwarded explicitly below — this handler passes named
    // arguments on to pythonService, so any field it does not name is dropped.
    muteMicDuringScreen?: boolean;
  }) => {
    const zipPath = payload?.zipPath;
    if (typeof zipPath !== 'string' || zipPath.trim() === '') {
      throw new Error('editor:export requires a non-empty zipPath string');
    }
    if (!fs.existsSync(zipPath)) {
      throw new Error(`editor:export zip file does not exist: ${zipPath}`);
    }

    // Per-story export carries a 'stories' array; on that path cuts MAY be empty (the user
    // can mark stories without cutting). Validate stories loudly when present. Python
    // re-validates and owns the coordinate math — this is a fast caller-bug guard.
    const stories = payload?.stories;
    const output = payload?.output;
    const isStoryExport = Array.isArray(stories) && stories.length > 0;
    if (isStoryExport) {
      if (output !== 'fcpxml' && output !== 'transcripts') {
        throw new Error(`editor:export with stories requires output 'fcpxml' or 'transcripts', got: ${output}`);
      }
      for (let i = 0; i < stories.length; i++) {
        const s = stories[i];
        if (!s || typeof s !== 'object') {
          throw new Error(`editor:export story at index ${i} is not an object`);
        }
        if (!Number.isInteger(s.number)) {
          throw new Error(`editor:export story at index ${i} has non-integer number: ${s.number}`);
        }
        if (typeof s.title !== 'string' || s.title.trim() === '') {
          throw new Error(`editor:export story at index ${i} (number ${s.number}) has an empty title`);
        }
        if (!Array.isArray(s.regions)) {
          throw new Error(`editor:export story ${s.title} regions must be an array`);
        }
        for (let j = 0; j < s.regions.length; j++) {
          const r = s.regions[j];
          if (!r || typeof r.start !== 'number' || typeof r.end !== 'number' || !(r.start < r.end)) {
            throw new Error(`editor:export story ${s.title} region ${j} is invalid: ${JSON.stringify(r)}`);
          }
        }
      }
    }

    const cuts = payload?.cuts;
    if (!Array.isArray(cuts) || (cuts.length === 0 && !isStoryExport)) {
      throw new Error('editor:export requires a non-empty cuts array');
    }
    for (let i = 0; i < cuts.length; i++) {
      const cut = cuts[i];
      if (!cut || typeof cut !== 'object') {
        throw new Error(`editor:export cut at index ${i} is not an object`);
      }
      const { startFrame, endFrame } = cut;
      if (!Number.isInteger(startFrame)) {
        throw new Error(`editor:export cut at index ${i} has non-integer startFrame: ${startFrame}`);
      }
      if (!Number.isInteger(endFrame)) {
        throw new Error(`editor:export cut at index ${i} has non-integer endFrame: ${endFrame}`);
      }
      if (startFrame < 0) {
        throw new Error(`editor:export cut at index ${i} has negative startFrame: ${startFrame}`);
      }
      if (startFrame >= endFrame) {
        throw new Error(`editor:export cut at index ${i} has startFrame >= endFrame: ${startFrame} >= ${endFrame}`);
      }
    }

    const muteMic = payload?.muteMicDuringScreen;
    if (muteMic !== undefined && typeof muteMic !== 'boolean') {
      throw new Error(`editor:export muteMicDuringScreen must be a boolean, got: ${typeof muteMic}`);
    }

    return await pythonService.editorExport(
      zipPath, cuts, isStoryExport ? stories : undefined, isStoryExport ? output : undefined,
      muteMic);
  });

  // ── Editor edit-state sidecar (<session>_edits.json next to the zip) ──────────
  // The zip is the IMMUTABLE generated artifact; mutable session state (cuts, blades,
  // stories, undo/redo) lives in a sidecar beside it — the same pattern as the
  // _transcript.json and _alignment.json sidecars. Missing file -> null (defined
  // "never edited" state); a file that exists but cannot be parsed is a REAL error
  // and propagates verbatim, never silently treated as fresh.
  const editsSidecarPath = (zipPath: string): string => {
    const dir = path.dirname(zipPath);
    const stem = path.basename(zipPath, '.zip');
    const session = stem.endsWith('_compounds') ? stem.slice(0, -'_compounds'.length) : stem;
    return path.join(dir, `${session}_edits.json`);
  };

  ipcMain.handle('editor:load-edits', async (_event, payload: { zipPath: string }) => {
    const zipPath = payload?.zipPath;
    if (typeof zipPath !== 'string' || zipPath.trim() === '') {
      throw new Error('editor:load-edits requires a non-empty zipPath string');
    }
    const p = editsSidecarPath(zipPath);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    try {
      return JSON.parse(raw);
    } catch (e: any) {
      throw new Error(`edit-state sidecar ${path.basename(p)} is not valid JSON: ${e.message} ` +
        `— fix or delete the file to continue`);
    }
  });

  ipcMain.handle('editor:save-edits', async (_event, payload: { zipPath: string; edits: any }) => {
    const zipPath = payload?.zipPath;
    if (typeof zipPath !== 'string' || zipPath.trim() === '') {
      throw new Error('editor:save-edits requires a non-empty zipPath string');
    }
    if (!payload?.edits || typeof payload.edits !== 'object') {
      throw new Error('editor:save-edits requires an edits object');
    }
    const p = editsSidecarPath(zipPath);
    // Atomic write: tmp + rename, so a crash mid-write can never corrupt the sidecar.
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload.edits), 'utf8');
    fs.renameSync(tmp, p);
    return { path: p };
  });

  // Whisper-transcribe the session's source audio tracks. Returns { jobId }
  // IMMEDIATELY; progress and completion are pushed to the WINDOW THAT INVOKED
  // this (event.sender), matching execute-workflow. On completion the renderer
  // receives 'transcribe-complete' with result on success, or result:null +
  // errorMessage carrying the loud message on any failure (including a pre-spawn
  // resolver failure — missing whisper-cli/model — surfaced via .catch).
  ipcMain.handle('editor:transcribe', async (event, payload: { zipPath: string }) => {
    const zipPath = payload?.zipPath;
    if (typeof zipPath !== 'string' || zipPath.trim() === '') {
      throw new Error('editor:transcribe requires a non-empty zipPath string');
    }
    if (!fs.existsSync(zipPath)) {
      throw new Error(`editor:transcribe zip file does not exist: ${zipPath}`);
    }

    const jobId = `transcribe_${Date.now()}`;
    const sender = event.sender;

    pythonService.transcribe(jobId, zipPath, {
      onProgress: (progress, message, etaSeconds) => {
        if (sender.isDestroyed()) return;
        sender.send('transcribe-progress', { jobId, progress, message, etaSeconds });
      },
      onComplete: (code, result, errorMessage) => {
        if (sender.isDestroyed()) return;
        sender.send('transcribe-complete', {
          jobId,
          exitCode: code,
          result: code === 0 ? (result ?? null) : null,
          errorMessage: code === 0 ? null : (errorMessage ?? null),
        });
      },
    }).catch((err: any) => {
      // Pre-spawn resolution failure (whisper-cli/model not found). Fail loud to
      // the renderer via the same completion channel so the UI never spins.
      const message = err?.message || String(err);
      log.error(`[${jobId}] transcribe failed before spawn: ${message}`);
      if (!sender.isDestroyed()) {
        sender.send('transcribe-complete', {
          jobId,
          exitCode: -1,
          result: null,
          errorMessage: message,
        });
      }
    });

    return { jobId };
  });

  // Cancel a running transcription. killProcess sends SIGTERM (its default
  // signal), which transcribe.py handles as a clean cancel.
  ipcMain.handle('editor:transcribe-cancel', async (_event, payload: { jobId: string }) => {
    const jobId = payload?.jobId;
    if (typeof jobId !== 'string' || jobId.trim() === '') {
      throw new Error('editor:transcribe-cancel requires a non-empty jobId string');
    }
    const killed = pythonService.killProcess(jobId);
    return { success: killed };
  });

  // Load the `<session>_transcript.json` sidecar next to the zip, deriving the
  // session name with the SAME rule the CLIs use (zip stem minus trailing
  // '_compounds'). Absence returns null (a normal state — no transcript yet); a
  // JSON parse failure is a loud throw, never a silent empty result.
  ipcMain.handle('editor:transcript-load', async (_event, payload: { zipPath: string }) => {
    const zipPath = payload?.zipPath;
    if (typeof zipPath !== 'string' || zipPath.trim() === '') {
      throw new Error('editor:transcript-load requires a non-empty zipPath string');
    }

    let stem = path.basename(zipPath, path.extname(zipPath)); // <name>_compounds
    if (stem.endsWith('_compounds')) {
      stem = stem.slice(0, -'_compounds'.length);
    }
    const transcriptPath = path.join(path.dirname(zipPath), `${stem}_transcript.json`);

    if (!fs.existsSync(transcriptPath)) {
      return null;
    }

    let raw: string;
    try {
      raw = fs.readFileSync(transcriptPath, 'utf8');
    } catch (err: any) {
      throw new Error(`Failed to read transcript sidecar ${transcriptPath}: ${err.message}`);
    }
    try {
      return JSON.parse(raw);
    } catch (err: any) {
      throw new Error(`Failed to parse transcript sidecar ${transcriptPath}: ${err.message}`);
    }
  });
}

/**
 * Manual-alignment wizard handlers.
 *
 * Cross-window flow (the app's first): the main window invokes 'alignment:open'
 * with the seed payload; the main process opens the wizard window and holds the
 * payload until the wizard pulls it via 'alignment:get-payload' (race-free) — it
 * is ALSO pushed on did-finish-load. The wizard finishes with 'alignment:complete'
 * (relayed to the main window as 'alignment-complete') or 'alignment:cancel'
 * (relayed as 'alignment-cancelled'); manually closing the window counts as cancel.
 * A single `settled` guard makes the main window's wait resolve exactly once.
 *
 * The peaks/samples channels stream through AlignmentAudioService (ffmpeg) and
 * FAIL LOUD — a rejected promise surfaces as { success:false, error } to the UI,
 * which blocks progression rather than fabricating a waveform.
 */
function setupAlignmentHandlers(windowService: WindowService): void {
  const audioService = new AlignmentAudioService();

  // Seed payload + one-shot settle guard for the current wizard session.
  let pendingPayload: any = null;
  let settled = true;

  const sendToMain = (channel: string, data: any) => {
    const main = windowService.getMainWindow();
    if (main && !main.isDestroyed() && main.webContents) {
      main.webContents.send(channel, data);
    }
  };

  ipcMain.handle('alignment:open', async (_event, payload: any) => {
    try {
      pendingPayload = payload || null;
      settled = false;

      const win = windowService.createEditorWindow();

      // Push the payload once the page has loaded (belt-and-suspenders; the wizard
      // also pulls it via 'alignment:get-payload' so there is no delivery race).
      win.webContents.once('did-finish-load', () => {
        if (!win.isDestroyed()) {
          win.webContents.send('alignment-payload', pendingPayload);
        }
      });

      // A manual window close (user hits the OS close button) is a cancellation —
      // but only if the wizard did not already complete/cancel explicitly.
      win.on('closed', () => {
        if (!settled) {
          settled = true;
          sendToMain('alignment-cancelled', { reason: 'window-closed' });
        }
      });

      return { success: true };
    } catch (error: any) {
      log.error('alignment:open failed:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });

  // Race-free pull of the seed payload by the wizard renderer on mount.
  ipcMain.handle('alignment:get-payload', async () => {
    return { success: true, payload: pendingPayload };
  });

  ipcMain.handle('alignment:complete', async (_event, overrides: any) => {
    if (!settled) {
      settled = true;
      sendToMain('alignment-complete', { overrides });
    }
    windowService.closeEditorWindow();
    return { success: true };
  });

  ipcMain.handle('alignment:cancel', async () => {
    if (!settled) {
      settled = true;
      sendToMain('alignment-cancelled', { reason: 'user-cancel' });
    }
    windowService.closeEditorWindow();
    return { success: true };
  });

  ipcMain.handle('alignment:scan-activity', async (_event, filePath: string) => {
    try {
      const scan = await audioService.scanActivity(filePath);
      return { success: true, ...scan };
    } catch (error: any) {
      log.error('alignment:scan-activity failed:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('alignment:extract-peaks', async (_event, opts: {
    filePath: string; startSec: number; durationSec: number; buckets: number;
  }) => {
    try {
      const peaks = await audioService.extractPeaks(opts.filePath, opts.startSec, opts.durationSec, opts.buckets);
      return { success: true, ...peaks };
    } catch (error: any) {
      log.error('alignment:extract-peaks failed:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('alignment:extract-samples', async (_event, opts: {
    filePath: string; startSec: number; durationSec: number; sampleRate: number;
  }) => {
    try {
      const seg = await audioService.extractSamples(opts.filePath, opts.startSec, opts.durationSec, opts.sampleRate);
      return { success: true, sampleRate: seg.sampleRate, samples: seg.samples };
    } catch (error: any) {
      log.error('alignment:extract-samples failed:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });
}

/**
 * Asset/download handlers — list, install, and cancel downloadable components
 * (ffmpeg/ffprobe, the Python env, models) that land in the shared OwenMorgan
 * location. Progress is streamed to the renderer via the 'asset-progress' event.
 */
function setupAssetHandlers(windowService: WindowService): void {
  const emitProgress = (p: any) => {
    const win = windowService.getMainWindow();
    if (win && !win.isDestroyed() && win.webContents) {
      win.webContents.send('asset-progress', p);
    }
  };

  ipcMain.handle('assets:list', async () => {
    try {
      return { success: true, components: assetManager.listStatus() };
    } catch (error: any) {
      log.error('assets:list failed:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('assets:install', async (_event, id: string) => {
    try {
      const result = await assetManager.install(id, emitProgress);
      return result;
    } catch (error: any) {
      log.error(`assets:install(${id}) failed:`, error);
      return { id, ok: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('assets:cancel', async (_event, id: string) => {
    assetManager.cancel(id);
    return { success: true };
  });

  ipcMain.handle('assets:ensure-required', async () => {
    try {
      return { success: true, ...(await assetManager.ensureRequired(emitProgress)) };
    } catch (error: any) {
      log.error('assets:ensure-required failed:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });
}

/**
 * File system related handlers
 */
function setupFileSystemHandlers(windowService: WindowService): void {
  // Select file dialog
  ipcMain.handle('select-file', async (event, options: { title?: string; filters?: any[]; properties?: any[] }) => {
    const window = windowService.getMainWindow();
    if (!window) return { canceled: true, filePaths: [] };

    const defaultFilters = [
      { name: 'Video Files', extensions: ['mp4', 'mov', 'avi', 'mkv', 'flv', 'wmv', 'mpg', 'mpeg', 'm4v', 'webm'] },
      { name: 'Audio Files', extensions: ['wav', 'mp3', 'aac', 'flac', 'ogg', 'm4a'] },
      { name: 'All Files', extensions: ['*'] }
    ];

    const result = await dialog.showOpenDialog(window, {
      title: options?.title || 'Select File',
      filters: (options?.filters && options.filters.length > 0) ? options.filters : defaultFilters,
      properties: options?.properties || ['openFile']
    });

    log.info('Select file dialog result:', result);
    return result;
  });

  // Select directory dialog
  ipcMain.handle('select-directory', async (event, options: { title?: string }) => {
    const window = windowService.getMainWindow();
    if (!window) return { canceled: true, filePaths: [] };

    const result = await dialog.showOpenDialog(window, {
      title: options.title || 'Select Directory',
      properties: ['openDirectory']
    });

    return result;
  });

  // Browse files in directory
  ipcMain.handle('browse-directory', async (event, dirPath: string) => {
    try {
      if (!fs.existsSync(dirPath)) {
        return { success: false, error: 'Directory does not exist' };
      }

      const items = fs.readdirSync(dirPath, { withFileTypes: true });
      const files = items
        .filter(item => !item.name.startsWith('.'))
        .map(item => {
          const itemPath = path.join(dirPath, item.name);
          const stats = fs.statSync(itemPath);

          return {
            name: item.name,
            path: itemPath,
            isDirectory: item.isDirectory(),
            size: item.isFile() ? stats.size : 0,
            modified: stats.mtime
          };
        })
        .sort((a, b) => {
          // Directories first, then files
          if (a.isDirectory && !b.isDirectory) return -1;
          if (!a.isDirectory && b.isDirectory) return 1;
          return a.name.localeCompare(b.name);
        });

      return { success: true, files };
    } catch (error: any) {
      log.error('Error browsing directory:', error);
      return { success: false, error: error.message };
    }
  });

  // Show file in Finder/Explorer
  ipcMain.handle('show-in-folder', async (event, filePath: string) => {
    try {
      shell.showItemInFolder(filePath);
      return { success: true };
    } catch (error: any) {
      log.error('Error showing file in folder:', error);
      return { success: false, error: error.message };
    }
  });

  // Open file with default application
  ipcMain.handle('open-file', async (event, filePath: string) => {
    try {
      await shell.openPath(filePath);
      return { success: true };
    } catch (error: any) {
      log.error('Error opening file:', error);
      return { success: false, error: error.message };
    }
  });

  // Check if file exists
  ipcMain.handle('check-file-exists', async (event, filePath: string) => {
    try {
      return { exists: fs.existsSync(filePath) };
    } catch (error: any) {
      return { exists: false, error: error.message };
    }
  });

  // Recursively search for files in directory
  ipcMain.handle('search-files-recursive', async (event, options: {
    rootPath: string;
    filenames: string[];
    maxDepth?: number;
  }) => {
    try {
      const { rootPath, filenames, maxDepth = 5 } = options;

      if (!fs.existsSync(rootPath)) {
        return { success: false, error: 'Root path does not exist' };
      }

      log.info(`Searching recursively for ${filenames.length} files in: ${rootPath}`);

      const foundFiles: { [filename: string]: string } = {};
      const normalizedFilenames = filenames.map(f => f.toLowerCase());

      // Recursive search function
      const searchDirectory = (dirPath: string, depth: number): void => {
        if (depth > maxDepth) return;

        try {
          const items = fs.readdirSync(dirPath, { withFileTypes: true });

          for (const item of items) {
            // Skip hidden files and system folders
            if (item.name.startsWith('.') || item.name === 'node_modules') continue;

            const itemPath = path.join(dirPath, item.name);

            if (item.isDirectory()) {
              // Recurse into subdirectory
              searchDirectory(itemPath, depth + 1);
            } else if (item.isFile()) {
              // Check if this file matches any of our target filenames
              const itemNameLower = item.name.toLowerCase();
              const matchIndex = normalizedFilenames.indexOf(itemNameLower);

              if (matchIndex !== -1) {
                const originalFilename = filenames[matchIndex];
                // Only store if we haven't found this file yet (first match wins)
                if (!foundFiles[originalFilename]) {
                  foundFiles[originalFilename] = itemPath;
                  log.info(`Found: ${originalFilename} at ${itemPath}`);
                }
              }
            }
          }
        } catch (error: any) {
          // Skip directories we can't read (permissions, etc.)
          log.debug(`Skipping directory ${dirPath}: ${error.message}`);
        }
      };

      // Start recursive search
      searchDirectory(rootPath, 0);

      log.info(`Search complete. Found ${Object.keys(foundFiles).length} of ${filenames.length} files`);
      return { success: true, foundFiles };
    } catch (error: any) {
      log.error('Error searching files recursively:', error);
      return { success: false, error: error.message };
    }
  });

  // Auto-detect audio files from master video directory
  ipcMain.handle('auto-detect-audio', async (event, masterVideoPath: string) => {
    try {
      if (!masterVideoPath || !fs.existsSync(masterVideoPath)) {
        return { success: false, error: 'Master video path is invalid' };
      }

      const dirPath = path.dirname(masterVideoPath);
      const masterFilename = path.basename(masterVideoPath, path.extname(masterVideoPath));

      // Extract session/prefix from master video filename
      // Extract everything before " master" (e.g., "2025-11-23 4 master" -> "2025-11-23 4")
      let session = '';
      const masterWordMatch = masterFilename.match(/^(.+?)\s+master$/i);
      if (masterWordMatch) {
        session = masterWordMatch[1].trim();
        log.info(`Extracted session: "${session}" from master video: ${masterFilename}`);
      } else {
        // No " master" suffix - use the full filename
        session = masterFilename;
        log.info(`Using full filename as session: "${session}" from master video: ${masterFilename}`);
      }

      // Escape special regex characters in session for safe pattern matching
      const escapeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escapedSession = escapeRegex(session);

      // Audio file patterns to match (keys use camelCase to match frontend types)
      // Note: mic1 also matches "mic audio.wav" (without number) for new VMix naming convention
      const audioPatterns: { [key: string]: RegExp } = {
        'mic1': new RegExp(`^${escapedSession}.*(?:mic\\s*1|mic_1|mic1|mic\\s+audio(?![\\s_-]*\\d)).*\\.(wav|mp3|aac|flac|ogg|m4a)$`, 'i'),
        'mic2': new RegExp(`^${escapedSession}.*(?:mic\\s*2|mic_2|mic2).*\\.(wav|mp3|aac|flac|ogg|m4a)$`, 'i'),
        'mic3': new RegExp(`^${escapedSession}.*(?:mic\\s*3|mic_3|mic3).*\\.(wav|mp3|aac|flac|ogg|m4a)$`, 'i'),
        'mic4': new RegExp(`^${escapedSession}.*(?:mic\\s*4|mic_4|mic4).*\\.(wav|mp3|aac|flac|ogg|m4a)$`, 'i'),
        'screen': new RegExp(`^${escapedSession}.*(?:screen|desktop).*\\.(wav|mp3|aac|flac|ogg|m4a)$`, 'i'),
        'game': new RegExp(`^${escapedSession}.*(?:game|gameplay).*\\.(wav|mp3|aac|flac|ogg|m4a)$`, 'i'),
        'soundEffects': new RegExp(`^${escapedSession}.*(?:sound[\\s_-]?effects?|sfx).*\\.(wav|mp3|aac|flac|ogg|m4a)$`, 'i'),
        'bluetooth': new RegExp(`^${escapedSession}.*(?:bluetooth|bt).*\\.(wav|mp3|aac|flac|ogg|m4a)$`, 'i')
      };

      // Video file patterns to match (keys use camelCase to match frontend types)
      const videoPatterns: { [key: string]: RegExp } = {
        'cam1': new RegExp(`^${escapedSession}\\s+cam\\.(mp4|mov|avi|mkv)$`, 'i'),
        'cam2': new RegExp(`^${escapedSession}\\s+cam\\s*2\\.(mp4|mov|avi|mkv)$`, 'i'),
        // A capture recorded in one go has no number; one that was stopped and
        // restarted is written as "... screen capture 1.mp4", "... 2.mp4", so the
        // unnumbered and the "1" form both mean the FIRST part. Parts 2 and 3 are
        // matched separately and become continuation sources, which the workflow
        // splices onto part 1 before anything else looks at them.
        'screenVideo': new RegExp(`^${escapedSession}\\s+screen\\s*capture(\\s*1)?\\.(mp4|mov|avi|mkv)$`, 'i'),
        'gameVideo': new RegExp(`^${escapedSession}\\s+game\\s*capture(\\s*1)?\\.(mp4|mov|avi|mkv)$`, 'i'),
        'screenVideo2': new RegExp(`^${escapedSession}\\s+screen\\s*capture\\s*2\\.(mp4|mov|avi|mkv)$`, 'i'),
        'screenVideo3': new RegExp(`^${escapedSession}\\s+screen\\s*capture\\s*3\\.(mp4|mov|avi|mkv)$`, 'i'),
        'gameVideo2': new RegExp(`^${escapedSession}\\s+game\\s*capture\\s*2\\.(mp4|mov|avi|mkv)$`, 'i'),
        'gameVideo3': new RegExp(`^${escapedSession}\\s+game\\s*capture\\s*3\\.(mp4|mov|avi|mkv)$`, 'i')
      };

      // Scan directory for matching audio and video files
      const items = fs.readdirSync(dirPath);
      const detectedAudio: { [key: string]: string } = {};
      const detectedVideo: { [key: string]: string } = {};

      // First pass: collect all matching files for each type
      const audioCandidatesByType: { [key: string]: string[] } = {};
      const videoCandidatesByType: { [key: string]: string[] } = {};

      for (const [audioType] of Object.entries(audioPatterns)) {
        audioCandidatesByType[audioType] = [];
      }

      for (const [videoType] of Object.entries(videoPatterns)) {
        videoCandidatesByType[videoType] = [];
      }

      for (const item of items) {
        const itemPath = path.join(dirPath, item);
        // A dangling symlink or a file removed mid-scan must skip that entry,
        // not abort the whole directory scan.
        let stats: fs.Stats;
        try {
          stats = fs.statSync(itemPath);
        } catch (statErr: any) {
          log.warn(`Skipping unreadable entry ${itemPath}: ${statErr.message}`);
          continue;
        }

        if (stats.isFile()) {
          // Check audio patterns
          for (const [audioType, pattern] of Object.entries(audioPatterns)) {
            if (pattern.test(item)) {
              audioCandidatesByType[audioType].push(itemPath);
            }
          }

          // Check video patterns
          for (const [videoType, pattern] of Object.entries(videoPatterns)) {
            if (pattern.test(item)) {
              videoCandidatesByType[videoType].push(itemPath);
            }
          }
        }
      }

      // A screen/game CAPTURE writes a companion wav next to its mp4
      // ("2026-08-05 screen capture 1.wav"), and the screen/game AUDIO patterns
      // above match those too, since they only look for "screen"/"game" anywhere
      // in the name. Which one won was down to readdir order. That is a
      // coin-flip this pipeline cannot afford: a capture companion can be
      // digital silence (a lost audio feed still records a full-length empty
      // track), and picking it would replace the session's desktop audio with
      // nothing at all. Capture companions are never an audio source, so they
      // are excluded outright.
      const isCaptureCompanion = (file: string) =>
        /\s(?:screen|game)\s*capture(\s*\d+)?\.(wav|mp3|aac|flac|ogg|m4a)$/i
          .test(path.basename(file));

      // Second pass: separate VMix and soundboard files
      for (const [audioType, rawCandidates] of Object.entries(audioCandidatesByType)) {
        const candidates = rawCandidates.filter(file => {
          if (!isCaptureCompanion(file)) return true;
          log.info(`Ignoring capture companion for ${audioType}: ${path.basename(file)}`);
          return false;
        });
        if (candidates.length === 0) continue;

        // Separate soundboard files from VMix files
        const sbFiles = candidates.filter(file => {
          const basename = path.basename(file);
          // Match: " sb.", "_sb.", "-sb.", " sb ", "_sb ", "-sb "
          return basename.match(/[\s_-]sb[\s\.]/i) || basename.match(/[\s_-]sb\.(wav|mp3|aac|flac|ogg|m4a)$/i);
        });

        const nonSbFiles = candidates.filter(file => !sbFiles.includes(file));

        // Assign VMix files (non-sb)
        if (nonSbFiles.length > 0) {
          detectedAudio[audioType] = nonSbFiles[0];
          log.info(`Detected ${audioType} (VMix): ${path.basename(nonSbFiles[0])}`);
        }

        // Assign soundboard files as separate type (camelCase with Sb suffix)
        if (sbFiles.length > 0) {
          const sbType = audioType + 'Sb';  // e.g., mic1 -> mic1Sb, screen -> screenSb
          detectedAudio[sbType] = sbFiles[0];
          log.info(`Detected ${sbType} (Soundboard): ${path.basename(sbFiles[0])}`);
        }
      }

      // Also look for desktop audio soundboard file
      // Desktop audio is Windows desktop audio, not typically in VMix but on soundboard
      const desktopPattern = new RegExp(`^${escapedSession}.*desktop.*\\.(wav|mp3|aac|flac|ogg|m4a)$`, 'i');
      for (const item of items) {
        const itemPath = path.join(dirPath, item);
        let stats: fs.Stats;
        try {
          stats = fs.statSync(itemPath);
        } catch (statErr: any) {
          log.warn(`Skipping unreadable entry ${itemPath}: ${statErr.message}`);
          continue;
        }
        if (stats.isFile() && desktopPattern.test(item)) {
          const basename = path.basename(item);
          // Match: " sb.", "_sb.", "-sb.", " sb ", "_sb ", "-sb "
          if (basename.match(/[\s_-]sb[\s\.]/i) || basename.match(/[\s_-]sb\.(wav|mp3|aac|flac|ogg|m4a)$/i)) {
            detectedAudio['desktopSb'] = itemPath;
            log.info(`Detected desktopSb (Soundboard): ${basename}`);
          }
        }
      }

      // Process video files - just take the first match
      for (const [videoType, candidates] of Object.entries(videoCandidatesByType)) {
        if (candidates.length > 0) {
          detectedVideo[videoType] = candidates[0];
          log.info(`Detected ${videoType}: ${path.basename(candidates[0])}`);
        }
      }

      return { success: true, audioFiles: detectedAudio, videoFiles: detectedVideo };
    } catch (error: any) {
      log.error('Error auto-detecting audio:', error);
      return { success: false, error: error.message };
    }
  });
}

/**
 * Dependency checking handlers
 */
function setupDependencyHandlers(): void {
  ipcMain.handle('check-dependencies', async () => {
    try {
      const result = await dependencyService.checkAllDependencies(false);
      return { success: true, dependencies: result };
    } catch (error: any) {
      log.error('Error checking dependencies:', error);
      return { success: false, error: error.message };
    }
  });

  // Install Python packages (only when user explicitly requests)
  ipcMain.handle('install-python-packages', async (event, packages: string[]) => {
    try {
      log.info('User requested installation of Python packages:', packages);
      const results: any = {};

      for (const pkg of packages) {
        log.info(`Installing ${pkg}...`);
        const result = await dependencyService.installPythonPackage(pkg);
        results[pkg] = result;

        if (!result.available) {
          log.error(`Failed to install ${pkg}:`, result.error);
        }
      }

      const allInstalled = Object.values(results).every((r: any) => r.available);
      return {
        success: allInstalled,
        results,
        error: allInstalled ? undefined : 'Some packages failed to install'
      };
    } catch (error: any) {
      log.error('Error installing Python packages:', error);
      return { success: false, error: error.message };
    }
  });
}

/**
 * Audio processing handlers
 */
function setupAudioHandlers(): void {
  // Process audio ducking (Dugan automixer - N tracks)
  ipcMain.handle('process-audio-ducking', async (event, options: {
    tracks: Array<{ type: string; filePath: string }>;
  }) => {
    try {
      log.info('Processing Dugan automixer:', options);

      const { tracks } = options;

      // Validate inputs
      if (!tracks || tracks.length < 2) {
        return { success: false, error: 'Need at least 2 audio tracks for Dugan automixer' };
      }

      for (const track of tracks) {
        if (!track.filePath || !fs.existsSync(track.filePath)) {
          return { success: false, error: `Audio file does not exist: ${track.filePath}` };
        }
      }

      const dugan = new DuganAutomixer();
      const duganTracks: DuganTrack[] = tracks.map(t => ({
        type: t.type,
        filePath: t.filePath
      }));

      const results = await dugan.process(duganTracks);

      log.info('Dugan automixer completed:', results);
      return {
        success: true,
        tracks: results.map(r => ({ type: r.type, filePath: r.filePath }))
      };
    } catch (error: any) {
      log.error('Error processing Dugan automixer:', error);
      return { success: false, error: error.message };
    }
  });
}

/**
 * Python execution handlers
 */
function setupPythonHandlers(): void {
  // Resolve managed binaries/envs the same way the rest of the app does.
  const binaryResolver = new BinaryResolver();

  // Execute Python workflow command
  ipcMain.handle('execute-workflow', async (event, options: any) => {
    try {
      const jobId = `job_${Date.now()}`;

      // Tell Python where the optional voice-isolation env lives (absolute path
      // or null when not installed). The `denoiseMics` boolean already arrives in
      // `options` from the frontend; this just supplies the env location Python
      // needs to run core/voice_separation.py.
      options.voiceSeparatorEnv = binaryResolver.getVoiceSeparatorEnvDir();

      log.info(`Starting workflow job: ${jobId}`, options);

      // Execute the workflow using the new electron_workflow.py script
      const sender = event.sender;
      const process = pythonService.executeWorkflow(jobId, {
        inputData: options,
        onOutput: (data) => {
          if (sender.isDestroyed()) return;
          log.info(`[${jobId}] Sending workflow-output (stdout) to renderer:`, data);
          sender.send('workflow-output', { jobId, type: 'stdout', data });
        },
        onError: (data) => {
          if (sender.isDestroyed()) return;
          log.info(`[${jobId}] Sending workflow-output (stderr) to renderer:`, data);
          sender.send('workflow-output', { jobId, type: 'stderr', data });
        },
        onProgress: (progress, message, subProgress) => {
          if (sender.isDestroyed()) return;
          log.info(`[${jobId}] Sending workflow-output (progress) to renderer: ${progress}% - ${message}`);
          sender.send('workflow-output', { jobId, type: 'progress', data: message, progress, sub_progress: subProgress });
        },
        onComplete: (code, result) => {
          if (sender.isDestroyed()) {
            log.warn(`[${jobId}] Cannot send workflow-complete — WebContents destroyed`);
            return;
          }
          log.info(`[${jobId}] Sending workflow-complete to renderer: exitCode=${code}`);
          sender.send('workflow-complete', { jobId, exitCode: code, result });
        }
      });

      return { success: true, jobId };
    } catch (error: any) {
      log.error('Error executing workflow:', error);
      return { success: false, error: error.message };
    }
  });

  // Measure per-source alignment offsets WITHOUT generating anything. Runs
  // electron_workflow.py in measure-only mode and returns the parsed measurement map
  // ({ audio: {...}, video: {...} }, per source { offsetSeconds, confidence, trusted })
  // used to pre-seed the manual-alignment UI. Reuses PythonService's spawn/parse infra.
  ipcMain.handle('alignment:measure', async (event, options: any) => {
    try {
      const jobId = `measure_${Date.now()}`;
      log.info(`Starting alignment measurement job: ${jobId}`, options);
      const sources = await pythonService.measureAlignment(jobId, options);
      return { success: true, sources };
    } catch (error: any) {
      log.error('Error measuring alignment:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });

  // Cancel a running job.
  //
  // TWO job systems answer on this ONE channel: PythonService workflows (this file's
  // original owner) and metadata-generation jobs ported from ContentStudio. Both sides
  // already used the identical contract — `(jobId: string) => { success, error? }` — so they
  // are merged here rather than split across two channel names. Splitting would have forced
  // the renderer to know which subsystem owns an id, which it does not.
  //
  // Metadata is consulted FIRST because its ids are registered explicitly; only if no
  // metadata job claims the id does this fall through to killing a python process. The
  // reverse order would let killProcess's "no such process" answer mask a real metadata job.
  ipcMain.handle('cancel-job', async (event, jobId: string) => {
    try {
      if (cancelMetadataJob(jobId)) {
        return { success: true };
      }

      const killed = pythonService.killProcess(jobId);
      return { success: killed };
    } catch (error: any) {
      log.error('Error canceling job:', error);
      return { success: false, error: error.message };
    }
  });

  // Send skip signal to current workflow
  ipcMain.handle('send-skip-signal', async (event) => {
    try {
      log.info('[SKIP IPC] Skip signal received from renderer');
      const sent = pythonService.sendSkipSignal();
      log.info('[SKIP IPC] pythonService.sendSkipSignal() returned:', sent);
      return { success: sent };
    } catch (error: any) {
      log.error('[SKIP IPC] Error sending skip signal:', error);
      return { success: false, error: error.message };
    }
  });
}

/**
 * Utility handlers
 */
function setupUtilityHandlers(): void {
  // Get app version
  ipcMain.handle('get-app-version', async () => {
    return require('electron').app.getVersion();
  });

  // Log message from renderer
  ipcMain.handle('log', async (event, level: string, ...args: any[]) => {
    switch (level) {
      case 'info':
        log.info(...args);
        break;
      case 'warn':
        log.warn(...args);
        break;
      case 'error':
        log.error(...args);
        break;
      default:
        log.debug(...args);
    }
  });
}

/**
 * Configuration handlers for asset paths
 */
function setupConfigHandlers(): void {
  const yaml = require('js-yaml');
  const { app } = require('electron');

  // Get user-writable config directory
  const getUserConfigDir = () => {
    return path.join(app.getPath('userData'), 'config');
  };

  // Get bundled config path (read-only, in app resources)
  const getBundledConfigPath = (filename: string) => {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'config', filename);
    } else {
      const projectRoot = path.join(__dirname, '../../../../');
      return path.join(projectRoot, 'config', filename);
    }
  };

  // Ensure user config exists (copy from bundled if not)
  const ensureUserConfig = (filename: string): string => {
    const userConfigDir = getUserConfigDir();
    const userConfigPath = path.join(userConfigDir, filename);
    const bundledConfigPath = getBundledConfigPath(filename);

    // Create user config directory if needed
    if (!fs.existsSync(userConfigDir)) {
      fs.mkdirSync(userConfigDir, { recursive: true });
      log.info('Created user config directory:', userConfigDir);
    }

    // Copy bundled config to user directory if it doesn't exist
    if (!fs.existsSync(userConfigPath)) {
      if (fs.existsSync(bundledConfigPath)) {
        fs.copyFileSync(bundledConfigPath, userConfigPath);
        log.info(`Copied bundled config to user directory: ${filename}`);
      } else {
        log.warn(`Bundled config not found: ${bundledConfigPath}`);
      }
    }

    return userConfigPath;
  };

  // Determine config path - use user-writable location for packaged apps
  const getConfigPath = () => {
    if (app.isPackaged) {
      // In packaged app, use user data directory (writable)
      return ensureUserConfig('autostudio_config.yaml');
    } else {
      // In development, use project root
      const projectRoot = path.join(__dirname, '../../../../');
      return path.join(projectRoot, 'config/autostudio_config.yaml');
    }
  };

  // Load asset paths configuration
  ipcMain.handle('get-asset-config', async () => {
    try {
      const configPath = getConfigPath();
      log.info('Loading config from:', configPath);

      if (!fs.existsSync(configPath)) {
        log.error('Config file not found at:', configPath);
        return { success: false, error: `Config file not found at: ${configPath}` };
      }

      const configContent = fs.readFileSync(configPath, 'utf8');
      const config = yaml.load(configContent);

      // Extract asset paths from config
      const assetPaths = {
        backgrounds: config.paths?.assets?.backgrounds || {},
        borders: config.paths?.assets?.borders || {}
      };

      log.info('Loaded asset config:', assetPaths);
      return { success: true, assetPaths };
    } catch (error: any) {
      log.error('Error loading asset config:', error);
      return { success: false, error: error.message };
    }
  });

  // Save asset paths configuration
  ipcMain.handle('save-asset-config', async (event, assetPaths: any) => {
    try {
      const configPath = getConfigPath();
      log.info('Saving config to:', configPath);

      if (!fs.existsSync(configPath)) {
        log.error('Config file not found at:', configPath);
        return { success: false, error: `Config file not found at: ${configPath}` };
      }

      const configContent = fs.readFileSync(configPath, 'utf8');
      const config = yaml.load(configContent);

      // Update asset paths in config
      if (!config.paths) config.paths = {};
      if (!config.paths.assets) config.paths.assets = {};

      config.paths.assets.backgrounds = assetPaths.backgrounds || {};
      config.paths.assets.borders = assetPaths.borders || {};

      // Write updated config back to file
      const updatedYaml = yaml.dump(config, {
        indent: 2,
        lineWidth: -1, // Don't wrap lines
        noRefs: true
      });

      fs.writeFileSync(configPath, updatedYaml, 'utf8');

      log.info('Saved asset config:', assetPaths);
      return { success: true };
    } catch (error: any) {
      log.error('Error saving asset config:', error);
      return { success: false, error: error.message };
    }
  });

  // Get drift corrections configuration
  ipcMain.handle('get-drift-corrections', async () => {
    try {
      const configPath = app.isPackaged
        ? ensureUserConfig('drift_corrections.json')
        : path.join(__dirname, '../../../../config/drift_corrections.json');
      log.info('Loading drift corrections from:', configPath);

      if (!fs.existsSync(configPath)) {
        log.error('Drift corrections config not found at:', configPath);
        // Return defaults
        const defaults = {
          vmix_outputs: {
            enabled: true,
            speed_factor: 1.0,
            applies_to: ['mic1', 'mic2', 'mic3', 'mic4', 'screen_audio', 'bluetooth', 'cam', 'master'],
            description: 'vMix outputs converted to 29.97fps'
          },
          vmix_sources: {
            enabled: true,
            speed_factor: 0.9999763884,
            applies_to: ['screen_capture_video', 'game_capture_video'],
            description: 'vMix direct source recordings'
          },
          soundboard: {
            enabled: true,
            speed_factor: 1.0000158402,
            applies_to: ['sound_effects'],
            description: 'External soundboard device'
          }
        };
        return defaults;
      }

      const configContent = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(configContent);

      log.info('Loaded drift corrections config:', config);
      return config;
    } catch (error: any) {
      // A corrupt/unparseable config must NOT be masked by returning plausible
      // defaults — that would silently discard the user's edited speed factors.
      // Fail loudly; the renderer's loadConfig() catch surfaces this to the user.
      // (The missing-file case is handled above and still returns defaults.)
      log.error('Error loading drift corrections config:', error);
      throw new Error(`Failed to load drift corrections: ${error.message}`);
    }
  });

  // Save drift corrections configuration
  ipcMain.handle('save-drift-corrections', async (event, config: any) => {
    try {
      const configPath = app.isPackaged
        ? ensureUserConfig('drift_corrections.json')
        : path.join(__dirname, '../../../../config/drift_corrections.json');
      log.info('Saving drift corrections to:', configPath);

      // Ensure directory exists
      const configDir = path.dirname(configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      // Write config to file
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

      log.info('Saved drift corrections config:', config);
      return { success: true };
    } catch (error: any) {
      log.error('Error saving drift corrections config:', error);
      return { success: false, error: error.message };
    }
  });
}

/**
 * Metadata-generation handlers, ported from ContentStudio's electron/ipc/ipc-handlers.ts.
 *
 * IPC channel names and payload/response shapes are preserved VERBATIM from ContentStudio.
 * That is deliberate and load-bearing: the Angular half of this feature is a port of the
 * same working pair, so copying both sides faithfully is what makes them meet. The one
 * exception is documented on 'metadata:select-directory' below.
 *
 * WHAT THIS RUNS: a two-phase pipeline. Phase 1 transcribes inputs (up to 5 concurrently —
 * WhisperService handles concurrent jobs). Phase 2 runs AI generation ONE job at a time,
 * because the local models are large enough that two resident at once is an OOM, and the
 * cloud providers have rate limits. Both phases are cancellable mid-flight.
 *
 * ADAPTED FROM ContentStudio:
 *  - Settings come from a locally-constructed electron-store rather than one created in
 *    main.ts and passed in — main.ts is not this port's to touch.
 *  - The analytics "CHANNEL PERFORMANCE DATA" feedback block is not wired: the analytics
 *    module was not ported. `insightsBlock` is simply left undefined, which the generator
 *    already treats as the normal "no mapping yet" state.
 *  - Whisper model selection is dropped from update-settings. AutoCutStudio's BinaryResolver
 *    PICKS the model it can prove is installed and logs which; honouring a stored preference
 *    that disagreed with the disk would make the transcript's provenance a lie.
 */
function setupMetadataHandlers(windowService: WindowService): void {
  const yaml = require('js-yaml');
  const Store = require('electron-store');
  const { app } = require('electron');

  // Settings live in their own store file rather than AutoCutStudio's YAML app-config:
  // this is the ContentStudio settings blob (providers, models, output dir, prompt set) and
  // keeping it separate means neither feature can corrupt the other's config on write.
  const store = new Store({ name: 'metadata-settings' });

  // ---- prompt sets ---------------------------------------------------------------
  // User-writable copies live in userData/prompt_sets; the bundled originals ship read-only
  // inside the app. Prompt sets are TUNED ARTIFACTS — a metadata run without one cannot
  // produce correct output at all — so a fresh install is seeded from the bundled set.

  const getPromptSetsDirectory = (): string =>
    path.join(app.getPath('userData'), 'prompt_sets');

  // Resolves to <projectRoot>/electron/services/metadata/assets in dev and to the same path
  // inside app.asar when packaged (package.json build.files ships the .yml files).
  const getSamplePromptsDirectory = (): string =>
    path.join(app.getAppPath(), 'electron', 'services', 'metadata', 'assets');

  const ensurePromptSetsDirectory = (): void => {
    const promptSetsDir = getPromptSetsDirectory();
    if (!fs.existsSync(promptSetsDir)) {
      fs.mkdirSync(promptSetsDir, { recursive: true });
      log.info(`Created prompt sets directory: ${promptSetsDir}`);
    }

    const existingPrompts = fs.readdirSync(promptSetsDir)
      .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));

    if (existingPrompts.length === 0) {
      const samplePromptsDir = getSamplePromptsDirectory();
      if (fs.existsSync(samplePromptsDir)) {
        const sampleFiles = fs.readdirSync(samplePromptsDir)
          .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
        for (const file of sampleFiles) {
          try {
            fs.copyFileSync(path.join(samplePromptsDir, file), path.join(promptSetsDir, file));
            log.info(`Copied sample prompt: ${file}`);
          } catch (error) {
            log.warn(`Failed to copy sample prompt ${file}:`, error);
          }
        }
        if (sampleFiles.length > 0) {
          log.info(`Installed ${sampleFiles.length} sample prompt(s) to help you get started`);
        }
      } else {
        log.info(`Sample prompts directory not found at: ${samplePromptsDir}`);
      }
    }

    // summarization_prompts.yml is pipeline config (not a user prompt set) — without
    // it, transcript summarization falls back to a generic prompt. Ensure it exists
    // even on installs whose prompt_sets directory already has prompts.
    const summarizationDest = path.join(promptSetsDir, 'summarization_prompts.yml');
    if (!fs.existsSync(summarizationDest)) {
      const summarizationSrc = path.join(getSamplePromptsDirectory(), 'summarization_prompts.yml');
      if (fs.existsSync(summarizationSrc)) {
        try {
          fs.copyFileSync(summarizationSrc, summarizationDest);
          log.info('Installed summarization_prompts.yml (pipeline config)');
        } catch (error) {
          log.warn('Failed to copy summarization_prompts.yml:', error);
        }
      }
    }
  };

  ensurePromptSetsDirectory();

  /**
   * Send an IPC message to the renderer, re-fetching the current window on every call.
   * Guards against "Object has been destroyed" crashes when the window is closed while a
   * long-running job's progress callback is still firing. Targets the MAIN window
   * explicitly — this app also opens editor/alignment windows, and progress for a metadata
   * job belongs to neither.
   */
  const sendToRenderer = (channel: string, payload: any): void => {
    const win = windowService.getMainWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  };

  // ==================== TWO-PHASE PIPELINE ====================
  // Phase 1: Transcription pool — up to 5 concurrent (WhisperService supports concurrent jobs)
  // Phase 2: AI generation queue — 1 at a time, sequential (protects AI API rate limits)

  interface PipelineJob {
    jobId: string;
    metadataParams: any;
    progressCallback: (phase: string, message: string, percent?: number, filename?: string, itemIndex?: number) => void;
    contentItems?: ContentItem[];
    resolve: (value: any) => void;
    reject: (error: any) => void;
    cancelled: boolean;
  }

  interface AiGenerationJob {
    jobId: string;
    execute: () => Promise<any>;
    resolve: (value: any) => void;
    reject: (error: any) => void;
  }

  const MAX_CONCURRENT_TRANSCRIPTIONS = 5;
  let activeTranscriptions = 0;
  const transcriptionQueue: PipelineJob[] = [];
  const aiGenerationQueue: AiGenerationJob[] = [];
  let isAiGenerationRunning = false;

  const enqueuePipelineJob = (job: PipelineJob): void => {
    const queuePosition = transcriptionQueue.length + activeTranscriptions;
    log.info(`[Pipeline] Enqueueing job: ${job.jobId} (${queuePosition} jobs ahead)`);
    transcriptionQueue.push(job);
    processTranscriptionQueue();
  };

  const processTranscriptionQueue = (): void => {
    while (activeTranscriptions < MAX_CONCURRENT_TRANSCRIPTIONS && transcriptionQueue.length > 0) {
      const job = transcriptionQueue.shift()!;

      if (job.cancelled) {
        job.resolve({ success: false, error: 'Job cancelled by user' });
        continue;
      }

      activeTranscriptions++;
      log.info(`[Pipeline] Starting transcription for job: ${job.jobId} (${activeTranscriptions} active, ${transcriptionQueue.length} queued)`);

      // Run transcription in background (don't await — allows multiple to run concurrently)
      runTranscription(job).finally(() => {
        activeTranscriptions--;
        log.info(`[Pipeline] Transcription finished for job: ${job.jobId} (${activeTranscriptions} active)`);
        processTranscriptionQueue();
      });
    }
  };

  const enqueueAiGenerationJob = (jobId: string, execute: () => Promise<any>): Promise<any> => {
    return new Promise((resolve, reject) => {
      const queuePosition = aiGenerationQueue.length + (isAiGenerationRunning ? 1 : 0);
      log.info(`[AiQueue] Enqueueing AI job: ${jobId} (position ${queuePosition})`);

      aiGenerationQueue.push({ jobId, execute, resolve, reject });

      // Send queue position to frontend for non-pipeline jobs
      if (queuePosition > 0) {
        sendToRenderer('generation-progress', {
          phase: 'queued',
          message: `Queued (position ${queuePosition})`,
          jobId
        });
      }

      processAiGenerationQueue();
    });
  };

  const processAiGenerationQueue = async (): Promise<void> => {
    if (isAiGenerationRunning || aiGenerationQueue.length === 0) {
      return;
    }

    isAiGenerationRunning = true;
    const job = aiGenerationQueue.shift()!;

    log.info(`[AiQueue] Starting AI job: ${job.jobId} (${aiGenerationQueue.length} remaining)`);

    try {
      const result = await job.execute();
      job.resolve(result);
    } catch (error) {
      log.error(`[AiQueue] AI job ${job.jobId} failed:`, error);
      job.reject(error);
    } finally {
      isAiGenerationRunning = false;
      log.info(`[AiQueue] AI job ${job.jobId} completed`);
      processAiGenerationQueue();
    }
  };

  const runTranscription = async (job: PipelineJob): Promise<void> => {
    try {
      const { WhisperService } = require('../services/metadata/whisper.service');
      const { InputHandlerService } = require('../services/metadata/input-handler.service');

      const whisperService = new WhisperService();
      const inputHandler = new InputHandlerService(whisperService, job.progressCallback);

      // Normalize inputs
      const normalizedInputs = job.metadataParams.inputs.map((input: any) => {
        if (typeof input === 'string') return input;
        if (input && typeof input === 'object' && input.path) return input.path;
        return String(input);
      });

      // Set up whisper progress forwarding
      whisperService.on('progress', (progress: any) => {
        if (job.cancelled) return;
        if (job.progressCallback && progress.videoPath) {
          const filename = progress.videoPath.split('/').pop() || progress.videoPath;
          let itemIndex: number | undefined = undefined;
          for (let i = 0; i < normalizedInputs.length; i++) {
            if (normalizedInputs[i] === progress.videoPath) {
              itemIndex = i;
              break;
            }
          }
          job.progressCallback('transcription', progress.message, progress.percent, filename, itemIndex);
        }
      });

      // Process inputs (transcription happens here). Collect per-input failures so
      // skipped items surface in result.warnings instead of silently vanishing.
      const customNotesMap = new Map(Object.entries(job.metadataParams.inputNotes || {}));
      const inputFailures: string[] = [];
      const contentItems = await inputHandler.processMultipleInputs(normalizedInputs, customNotesMap, inputFailures);

      if (job.cancelled) {
        job.resolve({ success: false, error: 'Job cancelled by user' });
        return;
      }

      if (contentItems.length === 0) {
        const errorMessage = inputFailures.length > 0
          ? `No content could be processed: ${inputFailures.join('; ')}`
          : 'No content could be processed';
        sendToRenderer('generation-progress', {
          phase: 'error',
          message: errorMessage,
          jobId: job.jobId
        });
        job.resolve({ success: false, error: errorMessage });
        return;
      }

      // Store content items and move to AI generation queue
      job.contentItems = contentItems;

      // Send queued status if AI generation is busy
      if (isAiGenerationRunning || aiGenerationQueue.length > 0) {
        sendToRenderer('generation-progress', {
          phase: 'queued',
          message: 'Waiting for AI generation...',
          jobId: job.jobId
        });
      }

      // Enqueue AI generation for this job
      enqueueAiGenerationJob(job.jobId, async () => {
        if (job.cancelled) {
          return { success: false, error: 'Job cancelled by user' };
        }

        const { MetadataGeneratorService } = require('../services/metadata/metadata-generator.service');

        const paramsWithCallback = {
          ...job.metadataParams,
          preTranscribedContent: job.contentItems,
          inputWarnings: inputFailures,
          progressCallback: job.progressCallback,
          cancelCallback: () => job.cancelled
        };

        const jobResult = await MetadataGeneratorService.generate(paramsWithCallback);

        // "Show prompt" flow: the transcript is done and the prompt is assembled, but
        // NO metadata call happened. Hold the transcript so "Send to AI" can reuse it,
        // and do NOT emit a terminal 'complete' — the frontend keys off the RESOLVED
        // value here, not a progress event. On failure we still surface a terminal
        // 'error' as usual. Warnings are forwarded because chapters DO run in this flow
        // now, so "chapters failed, the prompt you are reading has no chapter subjects"
        // has to reach the user while they are still deciding whether to send it.
        if (job.metadataParams.showPrompt) {
          if (jobResult.success) {
            heldTranscripts.set(job.jobId, {
              contentItems: job.contentItems!,
              metadataParams: job.metadataParams,
              computedChapters: jobResult.computedChapters,
            });
            return {
              success: true,
              prompts: jobResult.prompts,
              jobId: job.jobId,
              held: true,
              warnings: jobResult.warnings,
            };
          }
          sendToRenderer('generation-progress', {
            phase: 'error',
            message: jobResult.error || 'Unknown error'
          });
          return jobResult;
        }

        if (jobResult.success) {
          sendToRenderer('generation-progress', {
            phase: 'complete',
            message: 'Metadata generation complete!'
          });
        } else {
          sendToRenderer('generation-progress', {
            phase: 'error',
            message: jobResult.error || 'Unknown error'
          });
        }

        return jobResult;
      }).then(result => {
        job.resolve(result);
      }).catch(error => {
        // Generation THREW (rather than returning success:false) — emit a terminal error
        // event so progress-stream UIs don't hang on "generating".
        sendToRenderer('generation-progress', {
          phase: 'error',
          message: error instanceof Error ? error.message : String(error),
          jobId: job.jobId
        });
        job.reject(error);
      });

    } catch (error) {
      log.error(`[Pipeline] Transcription failed for job ${job.jobId}:`, error);
      sendToRenderer('generation-progress', {
        phase: 'error',
        message: error instanceof Error ? error.message : String(error),
        jobId: job.jobId
      });
      job.resolve({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  /**
   * Resolve provider/model/key from settings. Shared by generate-metadata and
   * analyze-transcript-split so a split can never run against a different model than the
   * generation the user is about to launch.
   */
  const resolveAiSettings = () => {
    const settings = (store as any).store;

    const apiKeysPath = path.join(app.getPath('userData'), 'api-keys.json');
    let apiKeys: any = {};
    if (fs.existsSync(apiKeysPath)) {
      apiKeys = JSON.parse(fs.readFileSync(apiKeysPath, 'utf-8'));
    }

    // Reconstruct the provider-prefixed model (e.g. "claude:claude-sonnet-4-5"). Settings
    // stores provider and model separately, but AIManagerService routes on the prefix.
    const aiModel = settings.metadataModel || settings.aiModel || settings.ollamaModel;
    const aiProvider = (settings.metadataProvider || settings.aiProvider || 'ollama') as 'ollama' | 'openai' | 'claude';
    const fullModel = aiModel ? `${aiProvider}:${aiModel}` : undefined;

    // Key strictly for the provider fullModel is built from. (OR-ing meta/summ providers
    // here would pick the wrong key when they differ.)
    let apiKey: string | undefined;
    if (aiProvider === 'openai') apiKey = apiKeys.openaiApiKey;
    else if (aiProvider === 'claude') apiKey = apiKeys.claudeApiKey;

    return { settings, aiProvider, aiModel, fullModel, apiKey };
  };

  // ==================== SETTINGS ====================

  /**
   * The output directory every metadata-store reader and writer must agree on: the stored
   * setting, or the default when it has never been set.
   *
   * Single source of truth for that default. 'get-settings' returns it (which is what the
   * Metadata and Reports pages read), and 'titles:save-report' writes into it — the two
   * MUST resolve identically or a titling report would land somewhere the Reports page
   * never looks.
   * NOTE: must stay in sync with MetadataGeneratorService.getDefaultOutputPath() in
   * electron/services/metadata/metadata-generator.service.ts, which fills the same gap for
   * the generation pipeline.
   */
  const resolveOutputDirectory = (): string =>
    (store as any).store.outputDirectory || path.join(os.homedir(), 'Documents', 'AutoCutStudio Output');

  ipcMain.handle('get-settings', async () => {
    try {
      const settings = { ...(store as any).store };

      // The frontend no longer hardcodes a fallback, so populate it when unset. This is NOT
      // persisted to disk — it only fills the returned object.
      if (!settings.outputDirectory) {
        settings.outputDirectory = resolveOutputDirectory();
      }

      return settings;
    } catch (error) {
      log.error('Error getting settings:', error);
      throw error;
    }
  });

  ipcMain.handle('update-settings', async (_event, settings) => {
    try {
      Object.keys(settings).forEach(key => {
        (store as any).set(key, settings[key]);
      });
      // NOTE: ContentStudio also applied settings.whisperModel here. Dropped on purpose —
      // see this function's header.
      return { success: true };
    } catch (error) {
      log.error('Error updating settings:', error);
      throw error;
    }
  });

  // ==================== FILE / DIRECTORY PICKERS ====================

  ipcMain.handle('select-files', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: 'Select Files',
        properties: ['openFile', 'multiSelections']
      });

      if (result.canceled) {
        return { success: false, files: [] };
      }

      return { success: true, files: result.filePaths };
    } catch (error) {
      log.error('Error selecting files:', error);
      throw error;
    }
  });

  // RENAMED FROM ContentStudio's 'select-directory'.
  //
  // This is the one channel that could not keep its name. AutoCutStudio already registers
  // 'select-directory' with an INCOMPATIBLE contract: it takes `{ title }` (and dereferences
  // it unconditionally, so calling it with no argument throws) and returns Electron's raw
  // `{ canceled, filePaths }`. ContentStudio's takes no argument and returns
  // `{ success, directory }`. One name cannot serve both, and reshaping either would break
  // its existing caller. The PAYLOAD AND RESPONSE SHAPE below are ContentStudio's, verbatim.
  ipcMain.handle('metadata:select-directory', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: 'Select Directory',
        properties: ['openDirectory']
      });

      if (result.canceled) {
        return { success: false, directory: null };
      }

      return { success: true, directory: result.filePaths[0] };
    } catch (error) {
      log.error('Error selecting directory:', error);
      throw error;
    }
  });

  ipcMain.handle('select-output-directory', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: 'Select Output Directory',
        properties: ['openDirectory', 'createDirectory']
      });

      if (result.canceled) {
        return { success: false, directory: null };
      }

      return { success: true, directory: result.filePaths[0] };
    } catch (error) {
      log.error('Error selecting output directory:', error);
      throw error;
    }
  });

  ipcMain.handle('is-directory', async (_event, filePath) => {
    try {
      const stats = await fs.promises.stat(filePath);
      return stats.isDirectory();
    } catch (error) {
      log.error('Error checking if path is directory:', error);
      return false;
    }
  });

  ipcMain.handle('read-directory', async (_event, dirPath) => {
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

      const directories: Array<{ name: string; path: string; mtime: Date; size: number }> = [];
      const files: Array<{ name: string; path: string; mtime: Date; size: number }> = [];

      for (const entry of entries) {
        const fullPath = `${dirPath}/${entry.name}`;
        const stats = await fs.promises.stat(fullPath);

        if (entry.isDirectory()) {
          directories.push({ name: entry.name, path: fullPath, mtime: stats.mtime, size: stats.size });
        } else if (entry.isFile()) {
          files.push({ name: entry.name, path: fullPath, mtime: stats.mtime, size: stats.size });
        }
      }

      return { success: true, directories, files };
    } catch (error) {
      log.error('Error reading directory:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('read-file', async (_event, filePath) => {
    try {
      return await fs.promises.readFile(filePath, 'utf-8');
    } catch (error) {
      log.error('Error reading file:', error);
      throw error;
    }
  });

  ipcMain.handle('delete-directory', async (_event, dirPath) => {
    try {
      await fs.promises.rm(dirPath, { recursive: true, force: true });
      return { success: true };
    } catch (error) {
      log.error('Error deleting directory:', error);
      throw error;
    }
  });

  // Check directory exists and is writable (auto-creates if missing)
  ipcMain.handle('check-directory', async (_event, dirPath) => {
    try {
      try {
        const stats = await fs.promises.stat(dirPath);
        if (!stats.isDirectory()) {
          return { exists: false, writable: false };
        }
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          try {
            await fs.promises.mkdir(dirPath, { recursive: true });
            log.info(`Created output directory: ${dirPath}`);
          } catch (mkdirError) {
            log.error('Failed to create directory:', mkdirError);
            return { exists: false, writable: false };
          }
        } else {
          throw error;
        }
      }

      // Writable is proven by writing, not by permission bits — network and synced
      // volumes lie about the latter.
      try {
        const testFile = path.join(dirPath, `.write-test-${Date.now()}`);
        await fs.promises.writeFile(testFile, 'test');
        await fs.promises.unlink(testFile);
        return { exists: true, writable: true };
      } catch (error) {
        return { exists: true, writable: false };
      }
    } catch (error) {
      log.error('Error checking directory:', error);
      return { exists: false, writable: false };
    }
  });

  ipcMain.handle('open-folder', async (_event, folderPath: string) => {
    try {
      await shell.openPath(folderPath);
      return { success: true };
    } catch (error) {
      log.error('Error opening folder:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('write-text-file', async (_event, filePath: string, content: string) => {
    try {
      await fs.promises.writeFile(filePath, content, 'utf-8');
      log.info(`Wrote text file: ${filePath}`);
      return { success: true };
    } catch (error) {
      log.error('Error writing text file:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('open-external', async (_event, url: string) => {
    try {
      await shell.openExternal(url);
      log.info(`Opened external URL: ${url}`);
      return { success: true };
    } catch (error) {
      log.error('Error opening external URL:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('get-app-path', () => app.getAppPath());

  // ==================== PROMPT SETS ====================

  ipcMain.handle('get-prompt-sets-path', async () => {
    return { success: true, path: getPromptSetsDirectory() };
  });

  ipcMain.handle('list-prompt-sets', async () => {
    try {
      const promptSetsDir = getPromptSetsDirectory();

      if (!fs.existsSync(promptSetsDir)) {
        fs.mkdirSync(promptSetsDir, { recursive: true });
        log.info(`Created prompt sets directory: ${promptSetsDir}`);
      }

      const files = fs.readdirSync(promptSetsDir);
      const promptSets: any[] = [];

      for (const file of files) {
        // summarization_prompts.yml is pipeline config, not a selectable prompt set
        if (file.startsWith('summarization_prompts')) {
          continue;
        }
        if (file.endsWith('.yml') || file.endsWith('.yaml')) {
          const content = fs.readFileSync(path.join(promptSetsDir, file), 'utf8');
          const parsed: any = yaml.load(content);

          promptSets.push({
            id: file.replace(/\.(yml|yaml)$/, ''),
            name: parsed.name || file,
            platform: parsed.platform || 'youtube',
            instructions_prompt: parsed.instructions_prompt || parsed.generation_instructions || ''
          });
        }
      }

      return { success: true, promptSets };
    } catch (error) {
      log.error('Error listing prompt sets:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('get-prompt-set', async (_event, promptSetId: string) => {
    try {
      const filePath = path.join(getPromptSetsDirectory(), `${promptSetId}.yml`);

      if (!fs.existsSync(filePath)) {
        return { success: false, error: 'Prompt set not found' };
      }

      const parsed: any = yaml.load(fs.readFileSync(filePath, 'utf8'));

      return {
        success: true,
        promptSet: {
          id: promptSetId,
          name: parsed.name || promptSetId,
          editorial_prompt: parsed.editorial_prompt || parsed.editorial_guidelines || '',
          instructions_prompt: parsed.instructions_prompt || parsed.generation_instructions || '',
          description_links: parsed.description_links || ''
        }
      };
    } catch (error) {
      log.error('Error getting prompt set:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('create-prompt-set', async (_event, promptSet: any) => {
    try {
      const safeId = promptSet.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const filePath = path.join(getPromptSetsDirectory(), `${safeId}.yml`);

      if (fs.existsSync(filePath)) {
        return { success: false, error: 'A prompt set with this name already exists' };
      }

      // {subject} is where the transcript gets substituted in. A prompt set without it
      // would send the model the instructions and no content at all.
      let editorialPrompt = promptSet.editorial_prompt || '';
      if (!editorialPrompt.includes('{subject}')) {
        editorialPrompt = editorialPrompt + '\n\n{subject}';
      }

      const yamlStr = yaml.dump({
        name: promptSet.name,
        editorial_prompt: editorialPrompt,
        instructions_prompt: promptSet.instructions_prompt || '',
        description_links: promptSet.description_links || ''
      }, { lineWidth: -1, noRefs: true });
      fs.writeFileSync(filePath, yamlStr, 'utf8');

      log.info(`Created new prompt set: ${safeId}`);
      return { success: true, id: safeId };
    } catch (error) {
      log.error('Error creating prompt set:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('update-prompt-set', async (_event, promptSetId: string, promptSet: any) => {
    try {
      const filePath = path.join(getPromptSetsDirectory(), `${promptSetId}.yml`);

      if (!fs.existsSync(filePath)) {
        return { success: false, error: 'Prompt set not found' };
      }

      const editorialPrompt = promptSet.editorial_prompt || '';
      if (!editorialPrompt.includes('{subject}')) {
        return { success: false, error: 'Editorial prompt must contain {subject} placeholder' };
      }

      const existingData: any = yaml.load(fs.readFileSync(filePath, 'utf8')) || {};

      existingData.name = promptSet.name || existingData.name;
      existingData.editorial_prompt = editorialPrompt;
      existingData.instructions_prompt = promptSet.instructions_prompt || '';
      existingData.description_links = promptSet.description_links || '';

      // Legacy field names, removed on write so a set can't carry two answers.
      delete existingData.platform;
      delete existingData.editorial_guidelines;
      delete existingData.generation_instructions;

      fs.writeFileSync(filePath, yaml.dump(existingData, { lineWidth: -1, noRefs: true }), 'utf8');

      log.info(`Updated prompt set: ${promptSetId}`);
      return { success: true };
    } catch (error) {
      log.error('Error updating prompt set:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('delete-prompt-set', async (_event, promptSetId: string) => {
    try {
      const filePath = path.join(getPromptSetsDirectory(), `${promptSetId}.yml`);

      if (!fs.existsSync(filePath)) {
        return { success: false, error: 'Prompt set not found' };
      }

      fs.unlinkSync(filePath);

      log.info(`Deleted prompt set: ${promptSetId}`);
      return { success: true };
    } catch (error) {
      log.error('Error deleting prompt set:', error);
      return { success: false, error: String(error) };
    }
  });

  // ==================== GENERATION ====================

  // Cancel a metadata job.
  //
  // FORCED RENAME from ContentStudio's 'cancel-job': this app already registers that
  // channel for PythonService workflow jobs, and ipcMain.handle THROWS on a duplicate
  // rather than shadowing — registering it twice would stop the app booting. The payload
  // (bare jobId string) and response ({ success, error? }) are ContentStudio's, unchanged.
  //
  // 'cancel-job' ALSO cancels metadata jobs: rather than register it twice, that existing
  // handler was extended to try metadata first and fall back to killing a python process.
  // Both channels share cancelMetadataJob(), so they cannot drift.
  ipcMain.handle('metadata:cancel-job', async (_event, jobId: string) => {
    try {
      log.info(`[IPC] Cancelling metadata job: ${jobId}`);
      if (cancelMetadataJob(jobId)) {
        return { success: true };
      }
      return { success: false, error: 'Job not found or already completed' };
    } catch (error) {
      log.error('Error cancelling metadata job:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('generate-metadata', async (_event, params) => {
    try {
      log.info('Starting metadata generation with params:', JSON.stringify(params, null, 2));

      const { settings, aiProvider, aiModel, fullModel, apiKey } = resolveAiSettings();
      const metaProvider = settings.metadataProvider || settings.aiProvider;

      log.info(`[IPC] Using AI model: ${fullModel} (provider: ${aiProvider}, model: ${aiModel})`);

      const activePromptSet = params.promptSet || settings.promptSet || 'sample-youtube';

      // Per-input notes arrive two ways: ContentStudio's separate `inputNotes` map keyed by
      // path, and inline on each input object (`{ path, notes }`). Both are accepted and
      // merged — an input carrying notes that the pipeline never reads would drop the
      // user's context silently, which is worse than any error. Inline wins on conflict
      // because it travels with the item the user typed it against.
      const inputNotes: { [key: string]: string } = { ...(params.inputNotes || {}) };
      if (Array.isArray(params.inputs)) {
        for (const input of params.inputs) {
          if (input && typeof input === 'object' && input.path && input.notes) {
            inputNotes[input.path] = input.notes;
          }
        }
      }

      const metadataParams = {
        inputs: params.inputs,
        mode: params.mode || settings.defaultMode,
        aiProvider: metaProvider,
        aiModel: fullModel,
        summarizationModel: fullModel,
        metadataModel: fullModel,
        aiApiKey: apiKey,
        aiHost: settings.ollamaHost || 'http://localhost:11434',
        outputPath: params.outputPath || settings.outputDirectory,
        promptSet: activePromptSet,
        promptSetsDir: getPromptSetsDirectory(),
        jobId: params.jobId,
        jobName: params.jobName,
        chapterFlags: params.chapterFlags || {},
        // Chapters are generated first, locally, and their subjects condition the
        // title/description/tag call — so this is deliberately independent of the
        // metadata provider above. It is always an Ollama model name.
        chapterModel: settings.chapterModel || 'cogito:14b',
        chapterStageModels: settings.chapterStageModels || undefined,
        chapterNumCtx: settings.chapterNumCtx || undefined,
        inputNotes,
        // ContentStudio resolved an analytics "CHANNEL PERFORMANCE DATA" block here.
        // Analytics was not ported; undefined is the generator's normal "no mapping" state.
        insightsBlock: undefined,
        // "Show prompt": transcribe + assemble the prompt, then STOP (no AI call).
        // The transcript is held server-side so "Send to AI" can reuse it.
        showPrompt: params.showPrompt || false
      };

      const safeMetadataParams = { ...metadataParams, aiApiKey: metadataParams.aiApiKey ? '***' : undefined };
      log.info('Prepared metadata params:', JSON.stringify(safeMetadataParams, null, 2));

      sendToRenderer('generation-progress', {
        phase: 'starting',
        message: 'Initializing metadata generation...'
      });

      // Submit to two-phase pipeline (transcription pool → AI generation queue)
      const result = await new Promise<any>((resolve, reject) => {
        const progressCallback = (phase: string, message: string, percent?: number, filename?: string, itemIndex?: number) => {
          log.info(`[IPC] Progress event: phase=${phase}, message=${message}, percent=${percent}, filename=${filename}, itemIndex=${itemIndex}`);
          sendToRenderer('generation-progress', {
            phase,
            message,
            percent,
            ...(filename && { filename }),
            ...(itemIndex !== undefined && { itemIndex })
          });
        };

        const pipelineJob: PipelineJob = {
          jobId: params.jobId || 'metadata-job',
          metadataParams,
          progressCallback,
          resolve,
          reject,
          cancelled: false
        };

        if (params.jobId) {
          metadataRunningJobs.set(params.jobId, {
            cancel: () => {
              pipelineJob.cancelled = true;
              log.info(`[Pipeline] Job ${params.jobId} marked as cancelled`);
              // Remove from transcription queue if still waiting
              const tIdx = transcriptionQueue.indexOf(pipelineJob);
              if (tIdx !== -1) {
                transcriptionQueue.splice(tIdx, 1);
                resolve({ success: false, error: 'Job cancelled by user' });
              }
            }
          });
        }

        enqueuePipelineJob(pipelineJob);
      });

      return result;

    } catch (error) {
      log.error('Error generating metadata:', error);
      // Terminal error event so progress-stream UIs don't hang on "generating"
      // when generation rejects rather than returning success:false.
      sendToRenderer('generation-progress', {
        phase: 'error',
        message: error instanceof Error ? error.message : String(error)
      });
      throw error;
    } finally {
      // Always release the cancel closure — on rejection too, not just success.
      if (params.jobId) {
        metadataRunningJobs.delete(params.jobId);
      }
    }
  });

  // "Send to AI" for a held ("Show prompt") transcript. Reuses the already-made
  // transcript (NO re-transcription) and runs the full metadata + chapters + output
  // generation, wiring progress + a terminal 'complete'/'error' exactly like the
  // normal AI phase so the frontend's existing progress handling finalizes the job.
  ipcMain.handle('send-held-prompt', async (_event, { jobId }: { jobId: string }) => {
    const held = heldTranscripts.get(jobId);
    if (!held) {
      // No fallback: never silently re-transcribe. Fail loud so the UI can tell the
      // user the transcript is gone and the analysis must be re-run.
      return { success: false, error: `No held transcript for job ${jobId} (it may have expired)` };
    }

    const progressCallback = (phase: string, message: string, percent?: number, filename?: string, itemIndex?: number) => {
      sendToRenderer('generation-progress', {
        phase,
        message,
        percent,
        ...(filename && { filename }),
        ...(itemIndex !== undefined && { itemIndex })
      });
    };

    try {
      // Serialize through the AI generation queue (1-at-a-time) like every other AI run.
      const result = await enqueueAiGenerationJob(jobId, async () => {
        const { MetadataGeneratorService } = require('../services/metadata/metadata-generator.service');

        const jobResult = await MetadataGeneratorService.generate({
          ...held.metadataParams,
          showPrompt: false,
          preTranscribedContent: held.contentItems,
          preComputedChapters: held.computedChapters,
          progressCallback,
        });

        if (jobResult.success) {
          sendToRenderer('generation-progress', { phase: 'complete', message: 'Metadata generation complete!' });
        } else {
          sendToRenderer('generation-progress', { phase: 'error', message: jobResult.error || 'Unknown error' });
        }

        return jobResult;
      });

      // Transcript consumed on success — drop it so it can't leak. On failure keep it
      // so the user can retry "Send to AI" without re-transcribing (cleared later by
      // discard-held-prompt or job cancel/removal).
      if (result && result.success) {
        heldTranscripts.delete(jobId);
      }
      return result;
    } catch (error) {
      // Generation THREW — emit a terminal error event so progress-stream UIs don't
      // hang on "generating". The held transcript is retained for a possible retry.
      sendToRenderer('generation-progress', {
        phase: 'error',
        message: error instanceof Error ? error.message : String(error),
        jobId
      });
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Discard a held ("Show prompt") transcript without sending it to the AI.
  ipcMain.handle('discard-held-prompt', async (_event, { jobId }: { jobId: string }) => {
    heldTranscripts.delete(jobId);
    return { success: true };
  });

  // ==================== JOB HISTORY (persisted reports) ====================

  /**
   * Persist ONE completed titling run into the metadata report store, so a set of titles can
   * be found again weeks later instead of living only in a queue row that a reload clears.
   *
   * Registered here rather than beside the other 'titles:*' channels in setupTitleHandlers
   * because it needs THIS block's settings store — the same store 'get-settings' answers
   * from, so the report is written to exactly the directory the Reports page reads.
   *
   * The record is the renderer's, verbatim: it is the only side that knows the story's name,
   * the band its badges were drawn against, and the generation order the user saw. What this
   * handler owns is where it lands.
   *
   * No output directory → { saved: false, reason: 'no-output-directory' }, NOT a throw: a
   * titling run is deliberately allowed to proceed without one (its output is on screen), and
   * a failed save must never read as a failed run. Note that with the default above,
   * resolveOutputDirectory() always answers, so this branch is a guard rather than a state
   * the app reaches today.
   *
   * A genuine write failure DOES throw, with the real error, so the renderer can say what
   * went wrong.
   */
  ipcMain.handle('titles:save-report', async (_event, report: TitleReport) => {
    if (!report || typeof report !== 'object') {
      throw new Error('titles:save-report requires a report object');
    }
    if (!Array.isArray(report.items) || report.items.length === 0) {
      throw new Error('titles:save-report requires a non-empty items array');
    }
    if (!report.job_name) {
      throw new Error('titles:save-report requires a job_name (it names the file and the report row)');
    }
    if (isNaN(new Date(report.created_at).getTime())) {
      throw new Error(`titles:save-report created_at is not a date: ${report.created_at}`);
    }
    // `chapters` is optional on an item, but a malformed one is refused rather than written:
    // the report is the record of what was published, and the Reports viewer would render a
    // half-formed chapter as "0:00 — Untitled" without ever saying the record was broken.
    report.items.forEach((item, i) => {
      const chapters = (item as any)?.chapters;
      if (chapters === undefined) return;
      if (!Array.isArray(chapters)) {
        throw new Error(`titles:save-report item ${i}: chapters is not an array`);
      }
      chapters.forEach((c: any, j: number) => {
        const ok = (v: any) => typeof v === 'string' && v.trim().length > 0;
        if (!c || typeof c !== 'object' || !ok(c.timestamp) || !ok(c.title) || typeof c.sequence !== 'number') {
          throw new Error(
            `titles:save-report item ${i}: chapter at index ${j} needs a non-empty timestamp, a ` +
            `non-empty title and a numeric sequence`
          );
        }
      });
    });

    const outputDirectory = resolveOutputDirectory();
    if (!outputDirectory) {
      log.warn('[Titles] No output directory configured — the titling report was not saved.');
      return { saved: false, reason: 'no-output-directory' };
    }

    const result = saveTitleReport(outputDirectory, report);
    log.info(`[Titles] Report saved: ${result.path}`);
    return result;
  });

  // Returns only text/subject-input jobs from the last 4 weeks.
  // Auto-prunes older job metadata files.
  ipcMain.handle('get-job-history', async () => {
    try {
      const outputDirectory = (store as any).store.outputDirectory;

      if (!outputDirectory) {
        return [];
      }

      const metadataDir = path.join(outputDirectory, '.contentstudio', 'metadata');

      if (!fs.existsSync(metadataDir)) {
        return [];
      }

      const files = fs.readdirSync(metadataDir);
      const jobs: any[] = [];
      // Resolved timestamp per job (created_at/createdAt, or file mtime fallback).
      // Used for both pruning and sorting so invalid dates never randomize order.
      const jobDates = new Map<any, number>();
      const fourWeeksAgo = Date.now() - (4 * 7 * 24 * 60 * 60 * 1000);

      for (const file of files) {
        if (file.startsWith('job-') && file.endsWith('.json')) {
          try {
            const filePath = path.join(metadataDir, file);
            const job = JSON.parse(fs.readFileSync(filePath, 'utf8'));

            // Auto-prune jobs older than 4 weeks. Fall back to the file's mtime when
            // created_at/createdAt is missing or invalid (otherwise NaN < cutoff is
            // false, so stale jobs never prune and NaN sort order is random).
            let createdAt = new Date(job.created_at || job.createdAt).getTime();
            if (isNaN(createdAt)) {
              createdAt = fs.statSync(filePath).mtimeMs;
            }
            if (createdAt < fourWeeksAgo) {
              log.info(`[JobHistory] Pruning old job: ${file} (created ${new Date(createdAt).toISOString()})`);
              try {
                if (job.txt_folder && fs.existsSync(job.txt_folder)) {
                  fs.rmSync(job.txt_folder, { recursive: true, force: true });
                }
                fs.unlinkSync(filePath);
              } catch (deleteError) {
                log.warn(`[JobHistory] Failed to prune ${file}:`, deleteError);
              }
              continue;
            }

            // Only include text/subject-input jobs in history.
            // Jobs without input_types are legacy and skipped (they age out).
            if (job.input_types && Array.isArray(job.input_types)) {
              const allSubjects = job.input_types.every((t: string) => t === 'subject');
              if (!allSubjects) {
                continue;
              }
            } else {
              continue;
            }

            job.metadataPath = filePath;
            jobDates.set(job, createdAt);
            jobs.push(job);
          } catch (error) {
            log.warn(`Error reading job metadata file ${file}:`, error);
          }
        }
      }

      // Sort by creation date (newest first), using the resolved timestamps
      jobs.sort((a, b) => (jobDates.get(b) ?? 0) - (jobDates.get(a) ?? 0));

      return jobs;
    } catch (error) {
      log.error('Error getting job history:', error);
      return [];
    }
  });

  ipcMain.handle('delete-job-history', async (_event, jobId: string) => {
    try {
      // Removing a job also drops any held "Show prompt" transcript for it.
      heldTranscripts.delete(jobId);

      const outputDirectory = (store as any).store.outputDirectory;

      if (!outputDirectory) {
        return { success: false, error: 'No output directory configured' };
      }

      const metadataDir = path.join(outputDirectory, '.contentstudio', 'metadata');

      if (!fs.existsSync(metadataDir)) {
        return { success: false, error: 'Metadata directory not found' };
      }

      for (const file of fs.readdirSync(metadataDir)) {
        if (file.startsWith('job-') && file.endsWith('.json')) {
          const filePath = path.join(metadataDir, file);

          try {
            const job = JSON.parse(fs.readFileSync(filePath, 'utf8'));

            // Check both job.id and job.job_id for compatibility
            if (job.id === jobId || job.job_id === jobId) {
              if (job.txt_folder && fs.existsSync(job.txt_folder)) {
                try {
                  fs.rmSync(job.txt_folder, { recursive: true, force: true });
                  log.info(`Deleted txt folder: ${job.txt_folder}`);
                } catch (error) {
                  log.warn(`Could not delete txt folder: ${job.txt_folder}`, error);
                }
              }

              fs.unlinkSync(filePath);
              log.info(`Deleted job history entry: ${jobId}`);
              return { success: true };
            }
          } catch (parseError) {
            log.warn(`Could not parse job file ${file}:`, parseError);
            continue;
          }
        }
      }

      return { success: false, error: 'Job not found' };
    } catch (error) {
      log.error('Error deleting job history:', error);
      return { success: false, error: String(error) };
    }
  });

  // ==================== AI SETUP ====================

  ipcMain.handle('check-ollama', async () => {
    try {
      const host = String((store as any).get('ollamaHost', 'http://localhost:11434')).replace(/\/$/, '');
      const { connected, models } = await ollamaService.listModels(host);
      return { available: connected, models: models.map(m => m.name) };
    } catch (error) {
      log.info('Ollama not available:', error);
      return { available: false, models: [] };
    }
  });

  // Reads API keys from the stored file when not supplied by the caller.
  ipcMain.handle('get-available-models', async (_event, provider: 'ollama' | 'openai' | 'claude', apiKey?: string, host?: string) => {
    try {
      log.info(`Getting available models for ${provider}`);

      let key = apiKey;
      if (!key && (provider === 'openai' || provider === 'claude')) {
        const apiKeysPath = path.join(app.getPath('userData'), 'api-keys.json');
        if (fs.existsSync(apiKeysPath)) {
          const data = JSON.parse(fs.readFileSync(apiKeysPath, 'utf-8'));
          key = provider === 'openai' ? data.openaiApiKey : data.claudeApiKey;
        }
      }

      const models = await AIManagerService.getAvailableModels(provider, key, host);
      log.info(`Found ${models.length} models for ${provider}`);
      return { success: true, models };
    } catch (error) {
      log.error(`Error getting models for ${provider}:`, error);
      return { success: false, models: [], error: String(error) };
    }
  });

  ipcMain.handle('get-api-keys', async () => {
    try {
      const apiKeysPath = path.join(app.getPath('userData'), 'api-keys.json');

      if (!fs.existsSync(apiKeysPath)) {
        return { claudeApiKey: undefined, openaiApiKey: undefined };
      }

      const data = JSON.parse(fs.readFileSync(apiKeysPath, 'utf-8'));

      // Masked, never returned in the clear — the renderer only needs to know one exists.
      return {
        claudeApiKey: data.claudeApiKey ? '***' : undefined,
        openaiApiKey: data.openaiApiKey ? '***' : undefined
      };
    } catch (error) {
      log.error('Error getting API keys:', error);
      return { claudeApiKey: undefined, openaiApiKey: undefined };
    }
  });

  ipcMain.handle('save-api-key', async (_event, provider: string, apiKey: string) => {
    try {
      const apiKeysPath = path.join(app.getPath('userData'), 'api-keys.json');

      let existingKeys: any = {};
      if (fs.existsSync(apiKeysPath)) {
        existingKeys = JSON.parse(fs.readFileSync(apiKeysPath, 'utf-8'));
      }

      if (provider === 'claude') {
        existingKeys.claudeApiKey = apiKey;
      } else if (provider === 'openai') {
        existingKeys.openaiApiKey = apiKey;
      } else {
        return { success: false, error: 'Invalid provider' };
      }

      fs.writeFileSync(apiKeysPath, JSON.stringify(existingKeys, null, 2), 'utf-8');

      log.info(`API key saved for ${provider}`);
      return { success: true };
    } catch (error) {
      log.error('Error saving API key:', error);
      return { success: false, error: String(error) };
    }
  });

  // ==================== TRANSCRIPT IMPORT ====================

  // Pick one or more AutoCutStudio transcript JSON files, validate them, and
  // return a per-story summary the renderer turns into input items. The heavy
  // lifting (words -> segments) happens later in the pipeline via InputHandler.
  ipcMain.handle('import-transcript', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: 'Import Transcript',
        filters: [
          { name: 'Transcript JSON', extensions: ['json'] },
          { name: 'All Files', extensions: ['*'] }
        ],
        properties: ['openFile', 'multiSelections']
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, items: [], errors: [] };
      }

      const items: any[] = [];
      const errors: string[] = [];

      for (const filePath of result.filePaths) {
        try {
          const raw = await fs.promises.readFile(filePath, 'utf-8');
          const parsed = parseTranscriptImport(raw, filePath);
          if (parsed.ok) {
            items.push({ path: filePath, ...parsed.data.summary });
          } else {
            errors.push(`${path.basename(filePath)}: ${parsed.error}`);
          }
        } catch (err) {
          errors.push(`${path.basename(filePath)}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return { success: items.length > 0, items, errors };
    } catch (error) {
      log.error('Error importing transcript:', error);
      return { success: false, items: [], errors: [String(error)] };
    }
  });

  // Analyze an imported transcript for logical subject-change boundaries.
  // Returns a chronological CANDIDATE menu; the user picks which become cuts.
  ipcMain.handle('analyze-transcript-split', async (_event, params: { filePath: string }) => {
    try {
      const { filePath } = params || ({} as any);
      if (!filePath) return { success: false, error: 'No transcript file provided.' };

      const raw = await fs.promises.readFile(filePath, 'utf-8');
      const parsed = parseTranscriptImport(raw, filePath);
      if (!parsed.ok) return { success: false, error: parsed.error };

      const srtSegments = wordsToSegments(parsed.data.words, parsed.data.meta.speakers);
      const totalDurationSeconds = parsed.data.summary.durationSeconds;

      const { settings, aiProvider, fullModel, apiKey } = resolveAiSettings();

      const aiConfig: AIConfig = {
        provider: aiProvider,
        metadataModel: fullModel,
        summarizationModel: fullModel,
        apiKey,
        host: settings.ollamaHost || 'http://localhost:11434',
      };
      const aiService = new AIManagerService(aiConfig);
      const initialized = await aiService.initialize();
      if (!initialized) {
        return {
          success: false,
          error: aiService.lastInitError
            ? `Failed to initialize AI service: ${aiService.lastInitError}`
            : 'Failed to initialize AI service',
        };
      }

      try {
        const chapters = await EpisodeSplitterService.detectChapters({
          srtSegments,
          totalDurationSeconds,
          aiService,
          provider: aiProvider,
        });
        return {
          success: true,
          title: parsed.data.meta.story.title,
          durationSeconds: totalDurationSeconds,
          chapters,
        };
      } finally {
        aiService.cleanup();
      }
    } catch (error) {
      log.error('Error analyzing transcript split:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Finalize a split: write N standalone transcript-import files (rebased to 0)
  // next to the original and return them as queue-item descriptors.
  ipcMain.handle('commit-transcript-split', async (_event, params: { filePath: string; cuts: TranscriptSliceCut[] }) => {
    try {
      const { filePath, cuts } = params || ({} as any);
      if (!filePath) return { success: false, error: 'No transcript file provided.' };
      if (!Array.isArray(cuts) || cuts.length === 0) return { success: false, error: 'No split points provided.' };

      const raw = await fs.promises.readFile(filePath, 'utf-8');
      const parsed = parseTranscriptImport(raw, filePath);
      if (!parsed.ok) return { success: false, error: parsed.error };

      const slices = buildTranscriptSlices(parsed.data, cuts);
      const dir = path.dirname(filePath);
      const base = path.basename(filePath, path.extname(filePath));
      const total = slices.length;

      const items: any[] = [];
      for (let i = 0; i < slices.length; i++) {
        const slice = slices[i];
        const outPath = path.join(dir, `${base}.part${i + 1}-of-${total}.json`);
        await fs.promises.writeFile(outPath, JSON.stringify(slice.file, null, 2), 'utf-8');
        items.push({
          path: outPath,
          displayName: slice.displayName,
          startSeconds: slice.startSeconds,
          endSeconds: slice.endSeconds,
          durationSeconds: slice.durationSeconds,
          wordCount: slice.wordCount,
        });
      }

      return { success: true, items };
    } catch (error) {
      log.error('Error committing transcript split:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

interface ProjectRegistryEntry {
  path: string;
  name: string;
  lastOpened: string;
}

interface ProjectRegistry {
  version: number;
  projects: ProjectRegistryEntry[];
}

interface ProjectScanResult {
  folder: string;
  realPath: string | null;
  exists: boolean;
  state: 'missing' | 'unrecognized' | 'raw' | 'processed' | 'edited';
  masterVideo?: string;
  session?: string;
  cleanName?: string;
  zipPath?: string;
  hasTranscript?: boolean;
  error?: string;
}

/**
 * Projects: the registry of session folders the user has opened, plus the scan that
 * classifies one folder by what it contains.
 *
 * A registry that has never been written is legitimately empty. A registry that EXISTS
 * but cannot be read as a version-1 registry is an error that propagates — it is never
 * reset or overwritten, because the file is the only record of where the user's projects
 * live and a silent reset would lose all of them.
 */
function setupProjectHandlers(): void {
  const { app } = require('electron');

  // The SAME config directory binary-resolver.ts exports as AUTOCUT_CONFIG_DIR, so the
  // registry sits beside drift_corrections.json and the other user config.
  const getConfigDir = (): string => {
    return app.isPackaged
      ? path.join(app.getPath('userData'), 'config')
      : path.join(__dirname, '../../../../', 'config');
  };

  const registryPath = (): string => path.join(getConfigDir(), 'projects.json');

  const MASTER_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv'];
  const MASTER_PATTERN = /^(.+?)\s+master$/i;

  ipcMain.handle('projects:read-registry', async (): Promise<ProjectRegistry> => {
    const p = registryPath();
    if (!fs.existsSync(p)) return { version: 1, projects: [] };

    const raw = fs.readFileSync(p, 'utf8');
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (e: any) {
      throw new Error(`projects registry ${p} is not valid JSON: ${e.message} ` +
        `— fix or delete the file to continue; it will not be overwritten`);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`projects registry ${p} is not an object (got ${Array.isArray(parsed) ? 'an array' : typeof parsed}) ` +
        `— fix or delete the file to continue; it will not be overwritten`);
    }
    if (parsed.version !== 1) {
      throw new Error(`projects registry ${p} has version ${JSON.stringify(parsed.version)}, expected 1 ` +
        `— fix or delete the file to continue; it will not be overwritten`);
    }
    if (!Array.isArray(parsed.projects)) {
      throw new Error(`projects registry ${p} has no projects array (projects is ${typeof parsed.projects}) ` +
        `— fix or delete the file to continue; it will not be overwritten`);
    }

    return parsed;
  });

  ipcMain.handle('projects:write-registry', async (_event, registry: ProjectRegistry) => {
    if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
      throw new Error('projects:write-registry requires a registry object');
    }
    if (registry.version !== 1) {
      throw new Error(`projects:write-registry expects version 1, got ${JSON.stringify(registry.version)}`);
    }
    if (!Array.isArray(registry.projects)) {
      throw new Error('projects:write-registry expects projects to be an array');
    }
    registry.projects.forEach((entry, i) => {
      if (!entry || typeof entry !== 'object') {
        throw new Error(`projects:write-registry entry ${i} is not an object`);
      }
      if (typeof entry.path !== 'string' || entry.path.trim() === '') {
        throw new Error(`projects:write-registry entry ${i} has no non-empty path string`);
      }
    });

    const dir = getConfigDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      log.info('Created config directory for projects registry:', dir);
    }

    const p = registryPath();
    // Atomic write: tmp + rename, so a crash mid-write can never corrupt the registry.
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(registry, null, 2), 'utf8');
    fs.renameSync(tmp, p);
    return { success: true };
  });

  ipcMain.handle('projects:scan-folder', async (_event, folderPath: string): Promise<ProjectScanResult> => {
    if (typeof folderPath !== 'string' || folderPath.trim() === '') {
      throw new Error('projects:scan-folder requires a non-empty folderPath string');
    }

    // A folder that is gone is a STATE, not an error — an unmounted volume comes back.
    const stat = fs.statSync(folderPath, { throwIfNoEntry: false });
    if (!stat || !stat.isDirectory()) {
      return { folder: folderPath, realPath: null, exists: false, state: 'missing' };
    }

    const realPath = fs.realpathSync(folderPath);
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    const fileNames = entries.filter(e => !e.isDirectory()).map(e => e.name);

    const masters = fileNames.filter(name => {
      if (!MASTER_EXTENSIONS.includes(path.extname(name).toLowerCase())) return false;
      return MASTER_PATTERN.test(path.basename(name, path.extname(name)));
    });

    if (masters.length === 0) {
      return {
        folder: folderPath, realPath, exists: true, state: 'unrecognized',
        error: `no master video in ${folderPath} — looked for a file named "<session> master" ` +
          `with extension ${MASTER_EXTENSIONS.join('/')}`
      };
    }
    if (masters.length > 1) {
      return {
        folder: folderPath, realPath, exists: true, state: 'unrecognized',
        error: `${masters.length} master videos in ${folderPath} — exactly one is required, found: ` +
          masters.join(', ')
      };
    }

    const masterName = masters[0];
    const session = path.basename(masterName, path.extname(masterName)).match(MASTER_PATTERN)![1].trim();
    const cleanName = session.replace(/ /g, '_');

    const zipPath = path.join(folderPath, `${cleanName}_compounds.zip`);
    const editsPath = path.join(folderPath, `${cleanName}_edits.json`);
    const hasZip = fs.existsSync(zipPath);
    const hasEdits = fs.existsSync(editsPath);
    const hasTranscript = fs.existsSync(path.join(folderPath, `${cleanName}_transcript.json`));

    const base: ProjectScanResult = {
      folder: folderPath,
      realPath,
      exists: true,
      state: 'raw',
      masterVideo: path.join(folderPath, masterName),
      session,
      cleanName,
      hasTranscript
    };
    if (hasZip) base.zipPath = zipPath;

    // Edits without the compounds zip they were made against: the folder is inconsistent,
    // and opening it as 'edited' would point the editor at a zip that is not there.
    if (hasEdits && !hasZip) {
      return {
        ...base,
        state: 'unrecognized',
        error: `${cleanName}_edits.json exists in ${folderPath} but ${cleanName}_compounds.zip does not ` +
          `— the saved edits refer to a processed session whose compounds zip is missing`
      };
    }

    base.state = hasEdits ? 'edited' : hasZip ? 'processed' : 'raw';
    return base;
  });
}
