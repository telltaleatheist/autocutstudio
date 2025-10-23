// electron/ipc/ipc-handlers.ts
import { ipcMain, dialog, shell } from 'electron';
import { spawn } from 'child_process';
import * as log from 'electron-log';
import { WindowService } from '../services/window-service';
import { PythonService } from '../services/python-service';
import { DependencyService } from '../services/dependency-service';
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
}

/**
 * File system related handlers
 */
function setupFileSystemHandlers(windowService: WindowService): void {
  // Select file dialog
  ipcMain.handle('select-file', async (event, options: { title?: string; filters?: any[] }) => {
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
      properties: ['openFile']
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

  // Auto-detect audio files from master video directory
  ipcMain.handle('auto-detect-audio', async (event, masterVideoPath: string) => {
    try {
      if (!masterVideoPath || !fs.existsSync(masterVideoPath)) {
        return { success: false, error: 'Master video path is invalid' };
      }

      const dirPath = path.dirname(masterVideoPath);
      const masterFilename = path.basename(masterVideoPath, path.extname(masterVideoPath));

      // Extract session from master video filename
      // Pattern 1: YYYY-MM-DD-N (e.g., 2024-01-15-1)
      // Pattern 2: YYYY-MM-DD-label (e.g., 2024-01-15-morning)
      const sessionMatch = masterFilename.match(/^(\d{4}-\d{2}-\d{2}(?:-\d+|-[a-zA-Z0-9]+)?)/);
      if (!sessionMatch) {
        return { success: false, error: 'Could not extract session from master video filename' };
      }
      const session = sessionMatch[1];
      log.info(`Extracted session: ${session} from master video: ${masterFilename}`);

      // Audio file patterns to match
      const audioPatterns: { [key: string]: RegExp } = {
        'mic-1': new RegExp(`^${session}.*(?:mic\\s*1|mic_1|mic1).*\\.(wav|mp3|aac|flac|ogg|m4a)$`, 'i'),
        'mic-2': new RegExp(`^${session}.*(?:mic\\s*2|mic_2|mic2).*\\.(wav|mp3|aac|flac|ogg|m4a)$`, 'i'),
        'mic-3': new RegExp(`^${session}.*(?:mic\\s*3|mic_3|mic3).*\\.(wav|mp3|aac|flac|ogg|m4a)$`, 'i'),
        'mic-4': new RegExp(`^${session}.*(?:mic\\s*4|mic_4|mic4).*\\.(wav|mp3|aac|flac|ogg|m4a)$`, 'i'),
        'screen': new RegExp(`^${session}.*(?:screen|desktop).*\\.(wav|mp3|aac|flac|ogg|m4a)$`, 'i'),
        'game': new RegExp(`^${session}.*(?:game|gameplay).*\\.(wav|mp3|aac|flac|ogg|m4a)$`, 'i'),
        'sound-effects': new RegExp(`^${session}.*(?:sound[\\s_-]?effects?|sfx).*\\.(wav|mp3|aac|flac|ogg|m4a)$`, 'i'),
        'bluetooth': new RegExp(`^${session}.*(?:bluetooth|bt).*\\.(wav|mp3|aac|flac|ogg|m4a)$`, 'i')
      };

      // Video file patterns to match
      const videoPatterns: { [key: string]: RegExp } = {
        'cam': new RegExp(`^${session}\\s+cam\\.(mp4|mov|avi|mkv)$`, 'i'),
        'cam-2': new RegExp(`^${session}\\s+cam\\s*2\\.(mp4|mov|avi|mkv)$`, 'i'),
        'screen-share': new RegExp(`^${session}\\s+screen\\s*share\\.(mp4|mov|avi|mkv)$`, 'i'),
        'game-share': new RegExp(`^${session}\\s+game\\s*share\\.(mp4|mov|avi|mkv)$`, 'i')
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
        const stats = fs.statSync(itemPath);

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

      // Second pass: prefer non-sb audio files, fall back to sb files
      for (const [audioType, candidates] of Object.entries(audioCandidatesByType)) {
        if (candidates.length === 0) continue;

        // Filter out files with " sb" or "_sb" in the name (case insensitive)
        const nonSbFiles = candidates.filter(file => {
          const basename = path.basename(file);
          return !basename.match(/[\s_-]sb[\s_.-]/i) && !basename.match(/[\s_-]sb\.(wav|mp3|aac|flac|ogg|m4a)$/i);
        });

        // Use non-sb file if available, otherwise use first sb file
        const selectedFile = nonSbFiles.length > 0 ? nonSbFiles[0] : candidates[0];
        detectedAudio[audioType] = selectedFile;

        const fileType = nonSbFiles.length > 0 ? 'non-sb' : 'sb';
        log.info(`Detected ${audioType} (${fileType}): ${path.basename(selectedFile)}`);
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
      const result = await dependencyService.checkAllDependencies();
      return { success: true, dependencies: result };
    } catch (error: any) {
      log.error('Error checking dependencies:', error);
      return { success: false, error: error.message };
    }
  });
}

/**
 * Audio processing handlers
 */
function setupAudioHandlers(): void {
  // Apply audio drift correction
  ipcMain.handle('apply-audio-drift', async (event, options: {
    inputPath: string;
    driftFrames: number;
    videoDuration: number;
    fps: number;
  }) => {
    try {
      log.info('Applying audio drift correction:', options);

      const { inputPath, driftFrames, videoDuration, fps } = options;

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
        const pythonProcess = spawn('python3', [
          path.join(__dirname, '../../cli/apply_audio_drift.py'),
          '--input', inputPath,
          '--drift-frames', driftFrames.toString(),
          '--duration', videoDuration.toString(),
          '--fps', fps.toString(),
          '--output', outputPath
        ]);

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

        // Handle process completion
        pythonProcess.on('close', (code: number | null) => {
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
          log.error('Drift correction process error:', error);
          resolve({ success: false, error: error.message });
        });

        // Timeout after 5 minutes
        setTimeout(() => {
          pythonProcess.kill();
          resolve({ success: false, error: 'Operation timed out after 5 minutes' });
        }, 5 * 60 * 1000);
      });
    } catch (error: any) {
      log.error('Error applying audio drift:', error);
      return { success: false, error: error.message };
    }
  });
}

/**
 * Python execution handlers
 */
function setupPythonHandlers(): void {
  // Execute Python workflow command
  ipcMain.handle('execute-workflow', async (event, options: any) => {
    try {
      const jobId = `job_${Date.now()}`;
      log.info(`Starting workflow job: ${jobId}`, options);

      // Execute the workflow using the new electron_workflow.py script
      const process = pythonService.executeWorkflow(jobId, {
        inputData: options,
        onOutput: (data) => {
          // Send regular output to renderer
          log.info(`[${jobId}] Sending workflow-output (stdout) to renderer:`, data);
          event.sender.send('workflow-output', { jobId, type: 'stdout', data });
        },
        onError: (data) => {
          // Send error to renderer
          log.info(`[${jobId}] Sending workflow-output (stderr) to renderer:`, data);
          event.sender.send('workflow-output', { jobId, type: 'stderr', data });
        },
        onProgress: (progress, message) => {
          // Send progress updates to renderer
          log.info(`[${jobId}] Sending workflow-output (progress) to renderer: ${progress}% - ${message}`);
          event.sender.send('workflow-output', { jobId, type: 'progress', data: message, progress });
        },
        onComplete: (code, result) => {
          // Send completion to renderer
          log.info(`[${jobId}] Sending workflow-complete to renderer: exitCode=${code}`);
          event.sender.send('workflow-complete', { jobId, exitCode: code, result });
        }
      });

      return { success: true, jobId };
    } catch (error: any) {
      log.error('Error executing workflow:', error);
      return { success: false, error: error.message };
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

  // Determine config path
  const getConfigPath = () => {
    if (app.isPackaged) {
      // In packaged app, use resources path
      return path.join(process.resourcesPath, 'config/autostudio_config.yaml');
    } else {
      // In development, find project root
      // __dirname is dist-electron/main/electron/ipc
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
}
