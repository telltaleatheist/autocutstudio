// electron/config/app-config.ts
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as log from 'electron-log';

/**
 * Application configuration
 * Manages paths and environment settings
 */
export class AppConfig {
  static isDevelopment = process.env.NODE_ENV === 'development';

  // Application paths (initialized in initialize())
  static appPath: string;
  static resourcesPath: string;
  static preloadPath: string;
  static frontendPath: string;
  static corePath: string;
  static cliPath: string;
  static configPath: string;

  /**
   * Initialize configuration
   * Must be called after app is ready
   */
  static initialize(): void {
    // Set app name
    app.setName('AutoCutStudio');

    // Ensure single instance
    if (!app.requestSingleInstanceLock()) {
      app.quit();
      process.exit(0);
    }

    // Initialize paths after app is ready
    const rawAppPath = app.getAppPath();
    const rawResourcesPath = process.resourcesPath;

    // Debug logging
    log.info(`[AppConfig] rawAppPath: ${rawAppPath}`);
    log.info(`[AppConfig] process.resourcesPath: ${rawResourcesPath}`);
    log.info(`[AppConfig] process.cwd(): ${process.cwd()}`);
    log.info(`[AppConfig] isDevelopment: ${AppConfig.isDevelopment}`);

    // Detect if we're running from node_modules Electron.app (npm start/development)
    // This is the most reliable indicator - if rawAppPath contains node_modules/electron,
    // we're definitely running from the development environment
    const isElectronApp = rawAppPath.includes('node_modules/electron/dist/Electron.app');
    log.info(`[AppConfig] isElectronApp: ${isElectronApp}`);

    // NEW: Check if CLI exists in current working directory (development)
    const cliInCwd = fs.existsSync(path.join(process.cwd(), 'cli', 'electron_workflow.py'));
    log.info(`[AppConfig] cliInCwd: ${cliInCwd} (${path.join(process.cwd(), 'cli', 'electron_workflow.py')})`);

    // A SINGLE mode decision drives every derived path so appPath, preloadPath,
    // and frontendPath can never disagree. `npm start` does not always set
    // NODE_ENV=development, so running from node_modules/electron OR finding the
    // CLI in cwd counts as development too. Previously appPath used this broader
    // signal while preloadPath/frontendPath keyed off NODE_ENV alone — under
    // `npm start` (no NODE_ENV) appPath resolved dev-style but preloadPath used
    // the packaged subpath, so the preload was never found and ALL IPC broke.
    // IMPORTANT: isElectronApp/cliInCwd are MORE important than the isDevelopment
    // flag because npm start doesn't always set NODE_ENV=development.
    const useDevPaths = isElectronApp || cliInCwd || AppConfig.isDevelopment;
    log.info(`[AppConfig] useDevPaths: ${useDevPaths}`);

    // Set paths based on environment
    if (useDevPaths) {
      // Running from node_modules/electron, CLI exists in cwd, or NODE_ENV=development
      if (isElectronApp || cliInCwd) {
        log.info('[AppConfig] Using process.cwd() (development mode detected)');
      } else {
        log.info('[AppConfig] Using process.cwd() (isDevelopment=true)');
      }
      AppConfig.appPath = process.cwd();
      AppConfig.resourcesPath = process.cwd();
    } else {
      // Production packaged app - use app bundle paths
      log.info('[AppConfig] Using app bundle paths (production)');
      AppConfig.appPath = rawAppPath;
      AppConfig.resourcesPath = rawResourcesPath || rawAppPath;
    }

    log.info(`[AppConfig] Final appPath: ${AppConfig.appPath}`);
    log.info(`[AppConfig] Final resourcesPath: ${AppConfig.resourcesPath}`);

    // Preload script path — derived from the SAME mode decision as appPath so the
    // preload subpath always matches the appPath resolution style.
    AppConfig.preloadPath = useDevPaths
      ? path.join(AppConfig.appPath, 'dist-electron', 'preload', 'preload.js')
      : path.join(AppConfig.appPath, 'dist-electron', 'main', 'electron', 'preload.js');

    // Frontend URL — derived from the SAME mode decision as appPath (both branches
    // currently resolve to the same subpath, but the mode source is now unified).
    AppConfig.frontendPath = useDevPaths
      ? path.join(AppConfig.appPath, 'frontend', 'dist', 'autocutstudio-frontend', 'browser', 'index.html')
      : path.join(AppConfig.appPath, 'frontend', 'dist', 'autocutstudio-frontend', 'browser', 'index.html');

    // Python paths - with fallback for packaged apps
    // Check if CLI path exists, if not, use alternative detection
    let cliPath = AppConfig.isDevelopment
      ? path.join(AppConfig.appPath, 'cli')
      : path.join(AppConfig.resourcesPath, 'cli');

    // If CLI path doesn't exist and we have process.resourcesPath, try that
    if (!fs.existsSync(path.join(cliPath, 'electron_workflow.py'))) {
      log.warn(`CLI path not found at: ${cliPath}, trying alternative locations`);
      log.info(`Checking process.resourcesPath: ${process.resourcesPath}`);

      const altCliPath = path.join(process.resourcesPath, 'cli', 'electron_workflow.py');
      log.info(`Looking for: ${altCliPath}`);
      log.info(`File exists: ${fs.existsSync(altCliPath)}`);

      // Try process.resourcesPath/cli
      if (process.resourcesPath && fs.existsSync(altCliPath)) {
        log.info('Found CLI at process.resourcesPath');
        AppConfig.resourcesPath = process.resourcesPath;
        AppConfig.appPath = process.resourcesPath;
      } else {
        // Try looking in the app bundle directly
        const appBundlePath = '/Applications/AutoCutStudio.app/Contents/Resources';
        const bundleCliPath = path.join(appBundlePath, 'cli', 'electron_workflow.py');
        log.info(`Trying hardcoded path: ${bundleCliPath}`);
        log.info(`File exists: ${fs.existsSync(bundleCliPath)}`);

        if (fs.existsSync(bundleCliPath)) {
          log.info('Found CLI at hardcoded app bundle path');
          AppConfig.resourcesPath = appBundlePath;
          AppConfig.appPath = appBundlePath;
        } else {
          log.error('Could not find CLI files in any expected location!');
        }
      }
    }

    AppConfig.corePath = AppConfig.isDevelopment
      ? path.join(AppConfig.appPath, 'core')
      : path.join(AppConfig.resourcesPath, 'core');

    AppConfig.cliPath = AppConfig.isDevelopment
      ? path.join(AppConfig.appPath, 'cli')
      : path.join(AppConfig.resourcesPath, 'cli');

    AppConfig.configPath = AppConfig.isDevelopment
      ? path.join(AppConfig.appPath, 'config', 'autostudio_config.yaml')
      : path.join(AppConfig.resourcesPath, 'config', 'autostudio_config.yaml');

    log.info(`Final CLI path: ${AppConfig.cliPath}`);
    log.info(`Final core path: ${AppConfig.corePath}`);
    log.info(`Final config path: ${AppConfig.configPath}`);
  }
}
