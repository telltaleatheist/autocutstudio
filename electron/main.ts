// electron/main.ts
import { app } from 'electron';
import * as log from 'electron-log';
import { AppConfig } from './config/app-config';
import { WindowService } from './services/window-service';
import { PythonService } from './services/python-service';
import { DependencyService } from './services/dependency-service';
import { setupIpcHandlers } from './ipc/ipc-handlers';

/**
 * Main application entry point
 */

// Allow up to 8 GB heap for large audio processing (Dugan automixer)
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=8192');

let windowService: WindowService;
let pythonService: PythonService;
let dependencyService: DependencyService;

// Configure logging
log.transports.console.level = 'info';
log.transports.file.level = 'debug';

// App is ready - start initialization
app.whenReady().then(async () => {
  try {
    // Initialize AppConfig (includes single instance lock)
    AppConfig.initialize();

    // Handle second instance attempt
    app.on('second-instance', () => {
      log.info('Second instance detected. Focusing main window.');
      if (windowService) {
        windowService.focusWindow();
      }
    });
    log.info('AutoCutStudio starting...');
    log.info(`App path: ${AppConfig.appPath}`);
    log.info(`Resources path: ${AppConfig.resourcesPath}`);
    log.info(`Development mode: ${AppConfig.isDevelopment}`);

    // Initialize services
    windowService = new WindowService();
    pythonService = new PythonService();
    dependencyService = new DependencyService();

    // Set up IPC handlers (do this BEFORE checking dependencies so the window can load)
    setupIpcHandlers(windowService, pythonService, dependencyService);

    // Create main window (always create the window, even if dependencies are missing)
    windowService.createMainWindow();

    // Required downloadable assets (ffmpeg/ffprobe, Python env) are driven by the
    // renderer's first-run setup screen (SetupComponent → assets:ensure-required),
    // so it can show progress and gate the UI. Nothing to do here.

    // Check dependencies in the background (non-blocking)
    // Pass FALSE to disable auto-install - we'll ask the user first
    log.info('Checking system dependencies in background...');
    dependencyService.checkAllDependencies(false).then(depCheck => {
      log.info('Dependency check complete:', {
        allAvailable: depCheck.allAvailable,
        python: depCheck.python.available,
        ffmpeg: depCheck.ffmpeg.available,
        ffprobe: depCheck.ffprobe.available,
        autoEditor: depCheck.autoEditor.available,
        pythonPackages: depCheck.pythonPackages ? {
          numpy: depCheck.pythonPackages.numpy.available,
          pillow: depCheck.pythonPackages.pillow.available,
          scipy: depCheck.pythonPackages.scipy.available,
          librosa: depCheck.pythonPackages.librosa.available
        } : 'not checked'
      });

      if (!depCheck.allAvailable) {
        const missingDeps: string[] = [];
        const missingPythonPackages: string[] = [];

        // Check system dependencies
        if (!depCheck.python.available) missingDeps.push('Python 3');
        if (!depCheck.ffmpeg.available) missingDeps.push('ffmpeg');
        if (!depCheck.ffprobe.available) missingDeps.push('ffprobe');
        if (!depCheck.autoEditor.available) missingDeps.push('auto-editor');

        // Check Python packages - only include if NOT available AND installation wasn't attempted
        // (If installation was attempted and succeeded, it will be available)
        if (depCheck.pythonPackages) {
          const np = depCheck.pythonPackages.numpy;
          const pil = depCheck.pythonPackages.pillow;
          const sp = depCheck.pythonPackages.scipy;
          const lr = depCheck.pythonPackages.librosa;

          if (!np.available) missingPythonPackages.push('numpy');
          if (!pil.available) missingPythonPackages.push('pillow (PIL)');
          if (!sp.available) missingPythonPackages.push('scipy');
          if (!lr.available) missingPythonPackages.push('librosa');
        }

        // ONLY send notification if there are ACTUALLY missing dependencies
        // (Don't send if auto-install succeeded)
        if (missingDeps.length > 0 || missingPythonPackages.length > 0) {
          log.warn('Some dependencies missing after auto-install attempt');
          log.warn('Missing system dependencies:', missingDeps);
          log.warn('Missing Python packages:', missingPythonPackages);

          // Show a notification in the app
          const mainWindow = windowService.getMainWindow();
          if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send('dependency-status', {
              allAvailable: false,
              missingSystemDeps: missingDeps,
              missingPythonPackages: missingPythonPackages,
              pythonPackagesInfo: depCheck.pythonPackages
            });
          }
        } else {
          log.info('All dependencies available after auto-install');
        }
      } else {
        log.info('All dependencies available');
      }
    }).catch(error => {
      log.error('Error checking dependencies:', error);
      // Don't block the app - just log the error
    });

    // macOS-specific behavior
    app.on('activate', () => {
      if (windowService.getAllWindows().length === 0) {
        windowService.createMainWindow();
      }
    });

  } catch (error) {
    log.error('Error during application initialization:', error);
    app.quit();
  }
});

// Quit when all windows are closed, except on macOS
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Cleanup before quitting
app.on('before-quit', () => {
  log.info('Application is quitting...');
  if (pythonService) {
    pythonService.killAllProcesses();
  }
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  log.error('Unhandled rejection at:', promise, 'reason:', reason);
});
