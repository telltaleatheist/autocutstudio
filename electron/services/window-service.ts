// electron/services/window-service.ts
import { BrowserWindow } from 'electron';
import * as log from 'electron-log';
import { AppConfig } from '../config/app-config';
import * as path from 'path';

/**
 * Window management service
 */
export class WindowService {
  private mainWindow: BrowserWindow | null = null;

  /**
   * Create the main application window
   */
  createMainWindow(): BrowserWindow {
    this.mainWindow = new BrowserWindow({
      width: 1400,
      height: 1000,
      minWidth: 1000,
      minHeight: 700,
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        preload: AppConfig.preloadPath
      }
    });

    // Load the frontend
    const frontendUrl = `file://${AppConfig.frontendPath}`;
    log.info(`Loading frontend from: ${frontendUrl}`);
    this.mainWindow.loadURL(frontendUrl);

    // DevTools disabled - uncomment to enable in development
    // if (AppConfig.isDevelopment) {
    //   this.mainWindow.webContents.openDevTools();
    // }

    // Window close handler
    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
    });

    return this.mainWindow;
  }

  /**
   * Show error window for missing dependencies
   */
  showDependencyErrorWindow(missingDeps: string[]): BrowserWindow {
    const errorWindow = new BrowserWindow({
      width: 600,
      height: 400,
      center: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: 'Missing Dependencies',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    const depList = missingDeps.map(dep => `<li>${dep}</li>`).join('');

    const errorHtml = `
      <html>
        <head>
          <title>Missing Dependencies</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
              margin: 0;
              padding: 20px;
              color: #333;
              background-color: #f5f5f5;
              display: flex;
              flex-direction: column;
              justify-content: center;
              align-items: center;
              height: 100vh;
            }
            .container {
              background-color: white;
              padding: 30px;
              border-radius: 8px;
              box-shadow: 0 2px 10px rgba(0,0,0,0.1);
              width: 100%;
              max-width: 550px;
            }
            h2 {
              color: #e74c3c;
              margin-top: 0;
            }
            p {
              line-height: 1.6;
              margin-bottom: 15px;
            }
            ul {
              background: #fff3cd;
              padding: 15px 15px 15px 35px;
              border-radius: 4px;
              border-left: 4px solid #ff6b35;
              margin: 15px 0;
            }
            li {
              margin: 5px 0;
              font-family: monospace;
            }
            button {
              background-color: #ff6b35;
              color: white;
              border: none;
              padding: 10px 20px;
              border-radius: 4px;
              cursor: pointer;
              font-size: 14px;
              margin-top: 10px;
            }
            button:hover {
              background-color: #e55529;
            }
            .install-code {
              background: #2d2d2d;
              color: #f8f8f2;
              padding: 10px;
              border-radius: 4px;
              font-family: monospace;
              font-size: 12px;
              margin: 10px 0;
              overflow-x: auto;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h2>⚠️ Missing Dependencies</h2>
            <p>AutoCutStudio requires the following dependencies to be installed:</p>
            <ul>${depList}</ul>
            <p><strong>Installation Instructions:</strong></p>
            <div class="install-code">
# Install ffmpeg and ffprobe (macOS with Homebrew)<br>
brew install ffmpeg<br>
<br>
# Install auto-editor<br>
pip3 install auto-editor
            </div>
            <p>After installing the dependencies, restart the application.</p>
            <button onclick="window.close()">Close Application</button>
          </div>
        </body>
      </html>
    `;

    errorWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(errorHtml)}`);

    errorWindow.on('closed', () => {
      process.exit(0);
    });

    return errorWindow;
  }

  /**
   * Focus the main window
   */
  focusWindow(): void {
    if (this.mainWindow) {
      if (this.mainWindow.isMinimized()) {
        this.mainWindow.restore();
      }
      this.mainWindow.focus();
    }
  }

  /**
   * Get all windows
   */
  getAllWindows(): BrowserWindow[] {
    return BrowserWindow.getAllWindows();
  }

  /**
   * Get the main window
   */
  getMainWindow(): BrowserWindow | null {
    return this.mainWindow;
  }
}
