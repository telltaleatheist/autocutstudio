// electron/config/app-config.ts
import { app } from 'electron';
import * as path from 'path';

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
    // In development, app.getAppPath() may return the Electron.app path
    // We need to use process.cwd() to get the actual project directory
    const rawAppPath = app.getAppPath();

    // Detect if we're running from the Electron.app bundle in node_modules
    const isElectronApp = rawAppPath.includes('node_modules/electron/dist/Electron.app');

    // Use process.cwd() if running from Electron.app or in dev mode
    AppConfig.appPath = (AppConfig.isDevelopment || isElectronApp) ? process.cwd() : rawAppPath;
    AppConfig.resourcesPath = process.resourcesPath || AppConfig.appPath;

    // Preload script path
    AppConfig.preloadPath = AppConfig.isDevelopment
      ? path.join(AppConfig.appPath, 'dist-electron', 'preload', 'preload.js')
      : path.join(AppConfig.appPath, 'dist-electron', 'main', 'electron', 'preload.js');

    // Frontend URL
    AppConfig.frontendPath = AppConfig.isDevelopment
      ? path.join(AppConfig.appPath, 'frontend', 'dist', 'autocutstudio-frontend', 'browser', 'index.html')
      : path.join(AppConfig.appPath, 'frontend', 'dist', 'autocutstudio-frontend', 'browser', 'index.html');

    // Python paths
    AppConfig.corePath = AppConfig.isDevelopment
      ? path.join(AppConfig.appPath, 'core')
      : path.join(AppConfig.resourcesPath, 'core');

    AppConfig.cliPath = AppConfig.isDevelopment
      ? path.join(AppConfig.appPath, 'cli')
      : path.join(AppConfig.resourcesPath, 'cli');

    AppConfig.configPath = AppConfig.isDevelopment
      ? path.join(AppConfig.appPath, 'config', 'autostudio_config.yaml')
      : path.join(AppConfig.resourcesPath, 'config', 'autostudio_config.yaml');
  }
}
