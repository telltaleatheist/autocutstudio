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
import * as fs from 'fs';
import * as path from 'path';

let pythonService: PythonService;
let dependencyService: DependencyService;

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
}

/**
 * View-only timeline editor handlers.
 *
 * Same cross-window seed-payload pattern as the alignment wizard, but DELIBERATELY
 * simpler and with its OWN state: the main window invokes 'editor:open' with a
 * { zipPath } payload; the main process opens/focuses the single editor window on
 * the '/editor' route and holds the payload until the editor pulls it via
 * 'editor:get-payload' (race-free) — it is ALSO pushed on did-finish-load. There is
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

  ipcMain.handle('editor:open', async (_event, payload: { zipPath: string }) => {
    try {
      const zipPath = payload?.zipPath;
      if (typeof zipPath !== 'string' || zipPath.trim() === '') {
        throw new Error('editor:open requires a non-empty zipPath string');
      }
      if (!fs.existsSync(zipPath)) {
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

    return await pythonService.editorExport(
      zipPath, cuts, isStoryExport ? stories : undefined, isStoryExport ? output : undefined);
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
        'screenVideo': new RegExp(`^${escapedSession}\\s+screen\\s*capture\\.(mp4|mov|avi|mkv)$`, 'i'),
        'gameVideo': new RegExp(`^${escapedSession}\\s+game\\s*capture\\.(mp4|mov|avi|mkv)$`, 'i')
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

      // Second pass: separate VMix and soundboard files
      for (const [audioType, candidates] of Object.entries(audioCandidatesByType)) {
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
  // Resolve the bundled/managed Python the same way the rest of the app does,
  // instead of assuming a bare 'python3' on PATH (which won't exist in a
  // packaged app and misses the app's PYTHONPATH / binary env).
  const binaryResolver = new BinaryResolver();

  // Apply audio drift correction
  ipcMain.handle('apply-audio-drift', async (event, options: {
    inputPath: string;
    driftFrames: number;
  }) => {
    try {
      log.info('Applying audio drift correction:', options);

      const { inputPath, driftFrames } = options;

      // Validate inputs
      if (!inputPath || !fs.existsSync(inputPath)) {
        return { success: false, error: 'Input file does not exist' };
      }

      // Generate output path
      const inputFile = path.parse(inputPath);
      const driftSuffix = driftFrames < 0
        ? `_drift_minus${Math.abs(driftFrames)}f`
        : `_drift_plus${driftFrames}f`;
      const outputPath = path.join(inputFile.dir, `${inputFile.name}${driftSuffix}${inputFile.ext}`);

      // Execute Python script to apply drift correction
      const jobId = `drift_${Date.now()}`;

      return new Promise((resolve) => {
        let outputData = '';
        let errorData = '';

        // Execute Python script directly
        const scriptPath = path.join(AppConfig.cliPath, 'apply_audio_drift.py');

        // Python script will auto-detect audio duration
        const pythonPath = binaryResolver.getPythonPath();
        const pythonProcess = spawn(pythonPath, [
          scriptPath,
          '--input', inputPath,
          '--drift-frames', driftFrames.toString(),
          '--output', outputPath
        ], {
          env: binaryResolver.getPythonEnv()
        });

        // Handle stdout
        pythonProcess.stdout.on('data', (data: Buffer) => {
          const output = data.toString();
          outputData += output;
          log.info('Drift correction output:', output);
        });

        // Handle stderr
        pythonProcess.stderr.on('data', (data: Buffer) => {
          const error = data.toString();
          errorData += error;
          log.error('Drift correction error:', error);
        });

        // Timeout after 5 minutes
        const timeoutId = setTimeout(() => {
          pythonProcess.kill();
          resolve({ success: false, error: 'Operation timed out after 5 minutes' });
        }, 5 * 60 * 1000);

        // Handle process completion
        pythonProcess.on('close', (code: number | null) => {
          clearTimeout(timeoutId);
          pythonProcess.removeAllListeners();
          if (code === 0 && fs.existsSync(outputPath)) {
            log.info('Drift correction completed successfully:', outputPath);
            resolve({ success: true, outputPath });
          } else {
            log.error('Drift correction failed with code:', code);
            resolve({ success: false, error: errorData || 'Failed to apply drift correction' });
          }
        });

        // Handle process errors
        pythonProcess.on('error', (error: Error) => {
          clearTimeout(timeoutId);
          pythonProcess.removeAllListeners();
          log.error('Drift correction process error:', error);
          resolve({ success: false, error: error.message });
        });
      });
    } catch (error: any) {
      log.error('Error applying audio drift:', error);
      return { success: false, error: error.message };
    }
  });

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

  // Cancel a running job
  ipcMain.handle('cancel-job', async (event, jobId: string) => {
    try {
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
