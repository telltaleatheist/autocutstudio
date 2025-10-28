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

    // Check dependencies in the background (non-blocking)
    log.info('Checking system dependencies in background...');
    dependencyService.checkAllDependencies(true).then(depCheck => {
      if (!depCheck.allAvailable) {
        const missingDeps: string[] = [];
        const missingPythonPackages: string[] = [];

        // Check system dependencies
        if (!depCheck.python.available) missingDeps.push('Python 3');
        if (!depCheck.ffmpeg.available) missingDeps.push('ffmpeg');
        if (!depCheck.ffprobe.available) missingDeps.push('ffprobe');
        if (!depCheck.autoEditor.available) missingDeps.push('auto-editor');

        // Check Python packages
        if (depCheck.pythonPackages) {
          if (!depCheck.pythonPackages.numpy.available) {
            missingPythonPackages.push('numpy');
          }
          if (!depCheck.pythonPackages.pillow.available) {
            missingPythonPackages.push('pillow (PIL)');
          }
          if (!depCheck.pythonPackages.scipy.available) {
            missingPythonPackages.push('scipy');
          }
          if (!depCheck.pythonPackages.librosa.available) {
            missingPythonPackages.push('librosa');
          }
        }

        if (missingDeps.length > 0 || missingPythonPackages.length > 0) {
          log.warn('Some dependencies missing, but app will continue to run');
          log.warn('Missing system dependencies:', missingDeps);
          log.warn('Missing Python packages:', missingPythonPackages);

          // Show a notification in the app instead of blocking
          const mainWindow = windowService.getMainWindow();
          if (mainWindow) {
            mainWindow.webContents.send('dependency-status', {
              allAvailable: false,
              missingSystemDeps: missingDeps,
              missingPythonPackages: missingPythonPackages,
              pythonPackagesInfo: depCheck.pythonPackages
            });
          }
        } else {
          log.info('All dependencies available');
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
