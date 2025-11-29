// electron/ipc/ipc-handlers.ts
import { ipcMain, dialog, shell } from 'electron';
import { spawn } from 'child_process';
import * as log from 'electron-log';
import { WindowService } from '../services/window-service';
import { PythonService } from '../services/python-service';
import { DependencyService } from '../services/dependency-service';
import { AppConfig } from '../config/app-config';
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
      const audioPatterns: { [key: string]: RegExp } = {
        'mic1': new RegExp(`^${escapedSession}.*(?:mic\\s*1|mic_1|mic1).*\\.(wav|mp3|aac|flac|ogg|m4a)$`, 'i'),
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
        const stats = fs.statSync(itemPath);
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
        const pythonProcess = spawn('python3', [
          scriptPath,
          '--input', inputPath,
          '--drift-frames', driftFrames.toString(),
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

  // Process audio ducking
  ipcMain.handle('process-audio-ducking', async (event, options: {
    audio1: string;
    audio2: string;
    mode: 'duck1' | 'duck2' | 'mutual';
    threshold: number;
  }) => {
    try {
      log.info('Processing audio ducking:', options);

      const { audio1, audio2, mode, threshold } = options;

      // Validate inputs
      if (!audio1 || !fs.existsSync(audio1)) {
        return { success: false, error: 'Audio file 1 does not exist' };
      }
      if (!audio2 || !fs.existsSync(audio2)) {
        return { success: false, error: 'Audio file 2 does not exist' };
      }

      // Execute Python script for audio ducking
      return new Promise((resolve) => {
        let outputData = '';
        let errorData = '';

        // Execute Python audio ducking script
        const scriptPath = path.join(AppConfig.cliPath, 'audio_ducking.py');
        log.info('Audio ducking script path:', scriptPath);

        const pythonProcess = spawn('python3', [
          scriptPath,
          audio1,
          audio2,
          mode,
          threshold.toString()
        ]);

        // Handle stdout
        pythonProcess.stdout.on('data', (data: Buffer) => {
          const output = data.toString();
          outputData += output;
          log.info('Audio ducking output:', output);
        });

        // Handle stderr (progress info goes here)
        pythonProcess.stderr.on('data', (data: Buffer) => {
          const error = data.toString();
          errorData += error;
          log.info('Audio ducking info:', error); // Often progress info goes to stderr

          // Parse and forward progress updates
          const lines = error.split('\n');
          for (const line of lines) {
            // Look for ffmpeg progress lines (e.g., "time=00:01:23.45")
            if (line.includes('time=') && line.includes('speed=')) {
              // Send progress notification to renderer
              event.sender.send('audio-ducking-progress', { message: line.trim() });
            }
          }
        });

        // Handle process completion
        pythonProcess.on('close', (code: number | null) => {
          if (code === 0) {
            // Parse output files from the output
            const outputFiles: string[] = [];

            // Extract file paths from output (look for lines with processed files)
            const lines = errorData.split('\n');
            for (const line of lines) {
              if (line.includes('_processed')) {
                const match = line.match(/saved to: (.+)/i) || line.match(/• (.+)/);
                if (match) {
                  outputFiles.push(match[1].trim());
                }
              }
            }

            // If we couldn't parse from output, construct expected paths
            if (outputFiles.length === 0) {
              const audio1File = path.parse(audio1);
              const audio2File = path.parse(audio2);

              if (mode === 'duck1' || mode === 'mutual') {
                outputFiles.push(path.join(audio1File.dir, `${audio1File.name}_processed.wav`));
              }
              if (mode === 'duck2' || mode === 'mutual') {
                outputFiles.push(path.join(audio2File.dir, `${audio2File.name}_processed.wav`));
              }
            }

            log.info('Audio ducking completed successfully:', outputFiles);
            resolve({ success: true, outputFiles });
          } else {
            log.error('Audio ducking failed with code:', code);
            resolve({ success: false, error: errorData || 'Failed to process audio ducking' });
          }
        });

        // Handle process errors
        pythonProcess.on('error', (error: Error) => {
          log.error('Audio ducking process error:', error);
          resolve({ success: false, error: error.message });
        });

        // Timeout after 10 minutes
        setTimeout(() => {
          pythonProcess.kill();
          resolve({ success: false, error: 'Operation timed out after 10 minutes' });
        }, 10 * 60 * 1000);
      });
    } catch (error: any) {
      log.error('Error processing audio ducking:', error);
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
        onProgress: (progress, message, subProgress) => {
          // Send progress updates to renderer
          log.info(`[${jobId}] Sending workflow-output (progress) to renderer: ${progress}% - ${message}`);
          event.sender.send('workflow-output', { jobId, type: 'progress', data: message, progress, sub_progress: subProgress });
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
      log.error('Error loading drift corrections config:', error);
      // Return defaults on error
      return {
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
