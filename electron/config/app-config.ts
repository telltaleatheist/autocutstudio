// electron/config/app-config.ts
import { app } from 'electron';
import * as path from 'path';

/**
 * Application configuration
 * Manages paths and environment settings
 */
export class AppConfig {
  static isDevelopment = process.env.NODE_ENV === 'development';

  // Application paths
  static appPath = app.getAppPath();
  static resourcesPath = process.resourcesPath || AppConfig.appPath;

  // Preload script path
  static preloadPath = AppConfig.isDevelopment
    ? path.join(AppConfig.appPath, 'dist-electron', 'preload', 'preload.js')
    : path.join(AppConfig.appPath, 'dist-electron', 'main', 'electron', 'preload.js');

  // Frontend URL
  static frontendPath = AppConfig.isDevelopment
    ? path.join(AppConfig.appPath, 'frontend', 'dist', 'autocutstudio-frontend', 'browser', 'index.html')
    : path.join(AppConfig.appPath, 'frontend', 'dist', 'autocutstudio-frontend', 'browser', 'index.html');

  // Python paths
  static corePath = AppConfig.isDevelopment
    ? path.join(AppConfig.appPath, 'core')
    : path.join(AppConfig.resourcesPath, 'core');

  static cliPath = AppConfig.isDevelopment
    ? path.join(AppConfig.appPath, 'cli')
    : path.join(AppConfig.resourcesPath, 'cli');

  static configPath = AppConfig.isDevelopment
    ? path.join(AppConfig.appPath, 'config', 'autostudio_config.yaml')
    : path.join(AppConfig.resourcesPath, 'config', 'autostudio_config.yaml');

  /**
   * Initialize configuration
   */
  static initialize(): void {
    // Set app name
    app.setName('AutoCutStudio');

    // Ensure single instance
    if (!app.requestSingleInstanceLock()) {
      app.quit();
      process.exit(0);
    }
  }
}
