const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // File Selection
  getDefaultDirectories: () => ipcRenderer.invoke('get-default-directories'),
  selectDirectory: (defaultPath) => ipcRenderer.invoke('select-directory', defaultPath),
  selectAudioFile: (defaultPath) => ipcRenderer.invoke('select-audio-file', defaultPath),

  // API Keys
  getApiKeys: () => ipcRenderer.invoke('get-api-keys'),
  saveApiKey: (provider, apiKey) => ipcRenderer.invoke('save-api-key', provider, apiKey),

  // Config
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),

  // Ollama
  checkOllama: (host) => ipcRenderer.invoke('check-ollama', host),

  // Transcription
  transcribeAudio: (audioPath, model) => ipcRenderer.invoke('transcribe-audio', audioPath, model),

  // AI Meeting Notes
  generateMeetingNotes: (transcript, config) => ipcRenderer.invoke('generate-meeting-notes', transcript, config),

  // Save & Open
  openFolder: (path) => ipcRenderer.invoke('open-folder', path),
  saveNotes: (notes, outputPath) => ipcRenderer.invoke('save-notes', notes, outputPath),
  saveNotesDialog: (notes, defaultPath) => ipcRenderer.invoke('save-notes-dialog', notes, defaultPath),

  // Progress Events
  onTranscriptionProgress: (callback) => {
    ipcRenderer.on('transcription-progress', (event, data) => callback(data));
  },
  removeTranscriptionProgressListener: () => {
    ipcRenderer.removeAllListeners('transcription-progress');
  }
});
