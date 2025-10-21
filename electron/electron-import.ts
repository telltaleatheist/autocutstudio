// Workaround for Electron module imports
// When running in Electron, require('electron') returns the Electron APIs
// When running in Node, it returns a string path to the binary
const electronModule = require('electron');

// Export the Electron APIs
export const app = electronModule.app;
export const BrowserWindow = electronModule.BrowserWindow;
export const ipcMain = electronModule.ipcMain;
export const dialog = electronModule.dialog;
export const shell = electronModule.shell;
