const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile('index.html');

  // Open DevTools if --dev-tools flag is passed
  if (process.argv.includes('--dev-tools')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function getUtilitiesPath() {
  // In development, utilities are in the project root
  // In production (packaged), they're in resources/utilities
  const devPath = path.join(__dirname, 'utilities');
  const prodPath = path.join(process.resourcesPath || '', 'utilities');

  if (fs.existsSync(devPath)) {
    return devPath;
  }
  return prodPath;
}

function getWhisperPath() {
  const utilitiesPath = getUtilitiesPath();

  // Select appropriate binary based on platform
  let binaryName;
  if (process.platform === 'darwin') {
    binaryName = 'whisper-cli';
  } else if (process.platform === 'win32') {
    binaryName = 'whisper-cli.exe';
  } else {
    binaryName = 'whisper-cli';
  }

  return path.join(utilitiesPath, 'bin', binaryName);
}

function getWhisperModelsPath() {
  const utilitiesPath = getUtilitiesPath();
  return path.join(utilitiesPath, 'models');
}

function getApiKeysPath() {
  return path.join(app.getPath('userData'), 'api-keys.json');
}

function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

// ============================================================================
// IPC HANDLERS - FILE SELECTION
// ============================================================================

// Get default directories
ipcMain.handle('get-default-directories', async () => {
  const outputPath = path.join(app.getPath('documents'), 'BoardNotes Output');
  return {
    output: fs.existsSync(outputPath) ? outputPath : app.getPath('documents')
  };
});

// Select directory dialog
ipcMain.handle('select-directory', async (event, defaultPath) => {
  const dialogOptions = {
    properties: ['openDirectory']
  };

  if (defaultPath && fs.existsSync(defaultPath)) {
    dialogOptions.defaultPath = defaultPath;
  }

  const result = await dialog.showOpenDialog(mainWindow, dialogOptions);
  if (result.canceled) {
    return null;
  }
  return result.filePaths[0];
});

ipcMain.handle('select-audio-file', async (event, defaultPath) => {
  const dialogOptions = {
    properties: ['openFile'],
    filters: [
      { name: 'Audio Files', extensions: ['wav', 'mp3', 'flac', 'm4a', 'ogg'] }
    ]
  };

  if (defaultPath && fs.existsSync(defaultPath)) {
    dialogOptions.defaultPath = defaultPath;
  }

  const result = await dialog.showOpenDialog(mainWindow, dialogOptions);
  if (result.canceled) {
    return null;
  }
  return result.filePaths[0];
});

// ============================================================================
// IPC HANDLERS - API KEYS
// ============================================================================

ipcMain.handle('get-api-keys', async () => {
  try {
    const apiKeysPath = getApiKeysPath();

    if (!fs.existsSync(apiKeysPath)) {
      return { claudeApiKey: undefined, openaiApiKey: undefined };
    }

    const data = JSON.parse(fs.readFileSync(apiKeysPath, 'utf-8'));

    // Return masked keys for security
    return {
      claudeApiKey: data.claudeApiKey ? '***' : undefined,
      openaiApiKey: data.openaiApiKey ? '***' : undefined
    };
  } catch (error) {
    console.error('Error getting API keys:', error);
    return { claudeApiKey: undefined, openaiApiKey: undefined };
  }
});

ipcMain.handle('save-api-key', async (event, provider, apiKey) => {
  try {
    const apiKeysPath = getApiKeysPath();

    let existingKeys = {};
    if (fs.existsSync(apiKeysPath)) {
      existingKeys = JSON.parse(fs.readFileSync(apiKeysPath, 'utf-8'));
    }

    if (provider === 'claude') {
      existingKeys.claudeApiKey = apiKey;
    } else if (provider === 'openai') {
      existingKeys.openaiApiKey = apiKey;
    } else {
      return { success: false, error: 'Invalid provider' };
    }

    fs.writeFileSync(apiKeysPath, JSON.stringify(existingKeys, null, 2), 'utf-8');
    return { success: true };
  } catch (error) {
    console.error('Error saving API key:', error);
    return { success: false, error: String(error) };
  }
});

// Get actual API key (for internal use)
function getApiKey(provider) {
  try {
    const apiKeysPath = getApiKeysPath();
    if (!fs.existsSync(apiKeysPath)) {
      return null;
    }
    const data = JSON.parse(fs.readFileSync(apiKeysPath, 'utf-8'));
    if (provider === 'claude') {
      return data.claudeApiKey;
    } else if (provider === 'openai') {
      return data.openaiApiKey;
    }
    return null;
  } catch (error) {
    return null;
  }
}

// ============================================================================
// IPC HANDLERS - CONFIG
// ============================================================================

ipcMain.handle('get-config', async () => {
  try {
    const configPath = getConfigPath();
    if (!fs.existsSync(configPath)) {
      return {
        aiProvider: 'ollama',
        aiModel: 'cogito:32b',
        ollamaHost: 'http://127.0.0.1:11434'
      };
    }
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (error) {
    return {
      aiProvider: 'ollama',
      aiModel: 'cogito:32b',
      ollamaHost: 'http://127.0.0.1:11434'
    };
  }
});

ipcMain.handle('save-config', async (event, config) => {
  try {
    const configPath = getConfigPath();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

// ============================================================================
// IPC HANDLERS - OLLAMA
// ============================================================================

ipcMain.handle('check-ollama', async (event, host) => {
  const axios = require('axios');
  const ollamaHost = host || 'http://127.0.0.1:11434';

  try {
    const response = await axios.get(`${ollamaHost}/api/tags`, { timeout: 5000 });
    const models = response.data.models || [];
    return {
      connected: true,
      models: models.map(m => ({ id: m.name, name: m.name }))
    };
  } catch (error) {
    // Try 127.0.0.1 as fallback on Windows
    if (ollamaHost.includes('localhost')) {
      try {
        const fallbackHost = ollamaHost.replace('localhost', '127.0.0.1');
        const response = await axios.get(`${fallbackHost}/api/tags`, { timeout: 5000 });
        const models = response.data.models || [];
        return {
          connected: true,
          models: models.map(m => ({ id: m.name, name: m.name }))
        };
      } catch (e) {
        return { connected: false, models: [] };
      }
    }
    return { connected: false, models: [] };
  }
});

// ============================================================================
// IPC HANDLERS - WHISPER TRANSCRIPTION
// ============================================================================

ipcMain.handle('transcribe-audio', async (event, audioPath, modelName = 'base') => {
  return new Promise((resolve, reject) => {
    const whisperPath = getWhisperPath();
    const modelsPath = getWhisperModelsPath();
    const modelPath = path.join(modelsPath, `ggml-${modelName}.bin`);

    if (!fs.existsSync(whisperPath)) {
      reject(new Error(`Whisper binary not found at ${whisperPath}`));
      return;
    }

    if (!fs.existsSync(modelPath)) {
      reject(new Error(`Whisper model not found at ${modelPath}`));
      return;
    }

    // Output to temp directory
    const os = require('os');
    const outputDir = path.join(os.tmpdir(), `boardnotes-${Date.now()}`);
    fs.mkdirSync(outputDir, { recursive: true });

    const basename = path.basename(audioPath, path.extname(audioPath));
    const outputBase = path.join(outputDir, basename);

    const args = [
      '-m', modelPath,
      '-f', audioPath,
      '-otxt',           // Output plain text
      '-of', outputBase, // Output file base
      '-pp',             // Print progress
      '-ng',             // No GPU - use CPU only
    ];

    console.log(`[Whisper] Starting transcription: ${audioPath}`);
    console.log(`[Whisper] Command: ${whisperPath} ${args.join(' ')}`);

    const proc = spawn(whisperPath, args, { cwd: outputDir });

    let stderr = '';
    let lastProgress = 0;

    proc.stdout?.on('data', (data) => {
      const chunk = data.toString();
      const progressMatch = chunk.match(/progress\s*=\s*(\d+)/i);
      if (progressMatch) {
        const progress = parseInt(progressMatch[1], 10);
        if (progress > lastProgress) {
          lastProgress = progress;
          mainWindow?.webContents.send('transcription-progress', {
            percent: progress,
            message: `Transcribing... ${progress}%`
          });
        }
      }
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
      const progressMatch = stderr.match(/progress\s*=\s*(\d+)/i);
      if (progressMatch) {
        const progress = parseInt(progressMatch[1], 10);
        if (progress > lastProgress) {
          lastProgress = progress;
          mainWindow?.webContents.send('transcription-progress', {
            percent: progress,
            message: `Transcribing... ${progress}%`
          });
        }
      }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        const txtPath = `${outputBase}.txt`;
        if (fs.existsSync(txtPath)) {
          const transcript = fs.readFileSync(txtPath, 'utf-8');
          // Clean up
          try {
            fs.rmSync(outputDir, { recursive: true });
          } catch (e) {
            // Ignore cleanup errors
          }
          resolve({ success: true, transcript });
        } else {
          reject(new Error('Transcription output file not found'));
        }
      } else {
        reject(new Error(`Whisper exited with code ${code}: ${stderr}`));
      }
    });

    proc.on('error', (error) => {
      reject(error);
    });
  });
});

// ============================================================================
// IPC HANDLERS - AI MEETING NOTES GENERATION
// ============================================================================

ipcMain.handle('generate-meeting-notes', async (event, transcript, config) => {
  const { provider, model, ollamaHost } = config;

  const systemPrompt = `You are an expert meeting note taker for the Secular Student Alliance board meetings.
Your task is to create clear, organized, and comprehensive meeting notes from the provided transcript.

FORMAT FOR EMAIL: The notes should be formatted for easy copying into an email. Use:
- Clear section headers in ALL CAPS or with emphasis markers
- Bullet points (•) for lists
- Indentation for sub-items
- Blank lines between sections for readability

Include these sections:
1. MEETING SUMMARY - A brief 2-3 sentence overview of the meeting
2. KEY DISCUSSION POINTS - Major topics discussed, organized by theme
3. ACTION ITEMS - Any tasks or commitments made, with assignees if mentioned
4. DECISIONS MADE - Any formal decisions or votes
5. FOLLOW-UP ITEMS - Topics to be revisited in future meetings

IMPORTANT: Do NOT include an "Attendees" section - the audio transcript cannot reliably identify who is speaking.

Be thorough but concise. Use bullet points for clarity.
If something is unclear in the transcript, note it as "[unclear]" rather than guessing.`;

  const userPrompt = `Please create comprehensive meeting notes from the following board meeting transcript:\n\n${transcript}`;

  try {
    if (provider === 'ollama') {
      return await generateWithOllama(userPrompt, systemPrompt, model, ollamaHost);
    } else if (provider === 'claude') {
      return await generateWithClaude(userPrompt, systemPrompt, model);
    } else if (provider === 'openai') {
      return await generateWithOpenAI(userPrompt, systemPrompt, model);
    } else {
      throw new Error(`Unknown provider: ${provider}`);
    }
  } catch (error) {
    console.error('Error generating meeting notes:', error);
    throw error;
  }
});

async function generateWithOllama(prompt, systemPrompt, model, host) {
  const axios = require('axios');
  const ollamaHost = host || 'http://127.0.0.1:11434';

  console.log(`[AI] Generating with Ollama: ${model}`);

  const response = await axios.post(`${ollamaHost}/api/generate`, {
    model: model,
    prompt: `${systemPrompt}\n\n${prompt}`,
    stream: false,
    keep_alive: 0, // Unload model from memory after completion
    options: {
      temperature: 0.7,
      num_predict: 4000
    }
  }, { timeout: 600000 }); // 10 minute timeout

  return {
    success: true,
    notes: response.data.response,
    provider: 'ollama',
    model: model
  };
}

async function generateWithClaude(prompt, systemPrompt, model) {
  const Anthropic = require('@anthropic-ai/sdk');
  const apiKey = getApiKey('claude');

  if (!apiKey) {
    throw new Error('Claude API key not configured');
  }

  console.log(`[AI] Generating with Claude: ${model}`);

  const anthropic = new Anthropic({ apiKey });

  // Map friendly names to actual model names
  const modelMap = {
    'claude-sonnet-4': 'claude-sonnet-4-5-20250929',
    'claude-3-5-sonnet': 'claude-sonnet-4-5-20250929',
    'claude-3-5-haiku': 'claude-3-5-haiku-20241022',
    'claude-3-haiku': 'claude-3-haiku-20240307',
    'claude-3-opus': 'claude-opus-4-5-20251101'
  };
  const actualModel = modelMap[model] || model;

  const response = await anthropic.messages.create({
    model: actualModel,
    max_tokens: 8000,
    system: systemPrompt,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7
  });

  const textBlock = response.content.find(block => block.type === 'text');

  return {
    success: true,
    notes: textBlock?.text || '',
    provider: 'claude',
    model: actualModel
  };
}

async function generateWithOpenAI(prompt, systemPrompt, model) {
  const OpenAI = require('openai');
  const apiKey = getApiKey('openai');

  if (!apiKey) {
    throw new Error('OpenAI API key not configured');
  }

  console.log(`[AI] Generating with OpenAI: ${model}`);

  const openai = new OpenAI({ apiKey });

  const response = await openai.chat.completions.create({
    model: model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt }
    ],
    max_tokens: 4000,
    temperature: 0.7
  });

  return {
    success: true,
    notes: response.choices[0]?.message?.content || '',
    provider: 'openai',
    model: model
  };
}

// ============================================================================
// IPC HANDLERS - SAVE & OPEN
// ============================================================================

ipcMain.handle('open-folder', async (event, folderPath) => {
  if (fs.existsSync(folderPath)) {
    shell.openPath(folderPath);
    return { success: true };
  }
  return { success: false, error: 'Folder does not exist' };
});

ipcMain.handle('save-notes', async (event, notes, outputPath) => {
  try {
    fs.writeFileSync(outputPath, notes, 'utf-8');
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('save-notes-dialog', async (event, notes, defaultPath) => {
  const date = new Date().toISOString().split('T')[0];
  const defaultFilename = `SSA Board Meeting Notes - ${date}.md`;

  const dialogOptions = {
    defaultPath: defaultPath ? path.join(defaultPath, defaultFilename) : defaultFilename,
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'Text', extensions: ['txt'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  };

  const result = await dialog.showSaveDialog(mainWindow, dialogOptions);

  if (result.canceled) {
    return { success: false, canceled: true };
  }

  try {
    fs.writeFileSync(result.filePath, notes, 'utf-8');
    return {
      success: true,
      filePath: result.filePath,
      folderPath: path.dirname(result.filePath)
    };
  } catch (error) {
    return { success: false, error: String(error) };
  }
});
