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
  private editorWindow: BrowserWindow | null = null;

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
   * Create the secondary editor window (a SECOND BrowserWindow).
   *
   * Hosts the manual-alignment wizard ('/alignment', the default so existing
   * callers stay unchanged) AND the view-only timeline editor ('/editor'). Uses
   * the SAME webPreferences/preload as the main window and loads the same built
   * Angular index, deep-linked to the requested route via a hash fragment
   * (HashLocationStrategy — see app-routing.module.ts). Sizing depends on the
   * route: the editor opens larger (a timeline needs the room).
   *
   * Only ONE such window may exist at a time. If one already exists on the SAME
   * route it is focused and returned; if it exists on a DIFFERENT route it is
   * re-pointed at the new route (loadURL) and focused — never duplicated.
   */
  createEditorWindow(route: '/alignment' | '/editor' = '/alignment'): BrowserWindow {
    // Per-route window geometry and title. '/alignment' keeps the historical
    // sizing exactly; '/editor' opens larger for the timeline UI.
    const isEditor = route === '/editor';
    const width = isEditor ? 1600 : 1200;
    const height = isEditor ? 900 : 700;
    const minWidth = isEditor ? 1200 : 900;
    const minHeight = isEditor ? 700 : 560;
    const title = isEditor ? 'Timeline Editor' : 'Manual Alignment';

    // Hash routing makes the deep-link work over file://.
    const routeUrl = `file://${AppConfig.frontendPath}#${route}`;

    if (this.editorWindow && !this.editorWindow.isDestroyed()) {
      // Reuse the single editor window. If it is on a different route, re-point
      // it; either way, focus and return it (never open a second one).
      const currentUrl = this.editorWindow.webContents.getURL();
      if (!currentUrl.endsWith(`#${route}`)) {
        log.info(`Re-pointing editor window to: ${routeUrl}`);
        this.editorWindow.setTitle(title);
        this.editorWindow.loadURL(routeUrl);
      }
      this.editorWindow.focus();
      return this.editorWindow;
    }

    // NOTE: deliberately NOT a child of the main window. On macOS a BrowserWindow with
    // a `parent` is an attached child that is pinned to the parent and cannot be dragged
    // onto a separate display — DisplayLink virtual monitors in particular. The editor is
    // a standalone tool window the user moves to a second monitor, so it must be top-level
    // and independently movable. (The alignment wizard was also parented and gains the same
    // freedom; it remains a single reused window either way.)
    this.editorWindow = new BrowserWindow({
      width,
      height,
      minWidth,
      minHeight,
      title,
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        preload: AppConfig.preloadPath
      }
    });

    log.info(`Loading editor window from: ${routeUrl}`);
    this.editorWindow.loadURL(routeUrl);

    this.editorWindow.on('closed', () => {
      this.editorWindow = null;
    });

    return this.editorWindow;
  }

  getEditorWindow(): BrowserWindow | null {
    return this.editorWindow;
  }

  closeEditorWindow(): void {
    if (this.editorWindow && !this.editorWindow.isDestroyed()) {
      this.editorWindow.close();
    }
    this.editorWindow = null;
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
