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

    // Check dependencies
    log.info('Checking system dependencies...');
    const depCheck = await dependencyService.checkAllDependencies();

    if (!depCheck.allAvailable) {
      const missingDeps: string[] = [];
      if (!depCheck.python.available) missingDeps.push('Python 3');
      if (!depCheck.ffmpeg.available) missingDeps.push('ffmpeg');
      if (!depCheck.ffprobe.available) missingDeps.push('ffprobe');
      if (!depCheck.autoEditor.available) missingDeps.push('auto-editor');

      log.error('Missing dependencies:', missingDeps);
      windowService.showDependencyErrorWindow(missingDeps);
      return;
    }

    log.info('All dependencies available');

    // Set up IPC handlers
    setupIpcHandlers(windowService, pythonService, dependencyService);

    // Create main window
    windowService.createMainWindow();

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
