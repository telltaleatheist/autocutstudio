// ============================================================================
// BOARDNOTES - RENDERER
// ============================================================================

// State
let outputDirectory = '';
let transcript = '';
let meetingNotes = '';
let currentAudioPath = '';

// Config
let config = {
  aiProvider: 'ollama',
  aiModel: 'cogito:32b',
  ollamaHost: 'http://127.0.0.1:11434',
  whisperModel: 'base'
};

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  // Load theme
  const savedTheme = localStorage.getItem('boardnotes-theme') || 'dark';
  document.body.setAttribute('data-theme', savedTheme);

  // Load output directory
  const dirs = await window.electronAPI.getDefaultDirectories();
  if (dirs.output) {
    outputDirectory = dirs.output;
  }

  // Load config
  const savedConfig = await window.electronAPI.getConfig();
  config = { ...config, ...savedConfig };
  applyConfig();

  // Load API keys status
  await checkApiKeys();

  // Setup event listeners
  setupEventListeners();
  setupProgressListeners();
});

function applyConfig() {
  document.getElementById('ai-provider').value = config.aiProvider;
  document.getElementById('ai-model').value = config.aiModel;
  document.getElementById('ollama-host').value = config.ollamaHost || 'http://127.0.0.1:11434';
  document.getElementById('whisper-model').value = config.whisperModel || 'base';

  // Show/hide Ollama host based on provider
  updateProviderUI();
}

async function checkApiKeys() {
  const keys = await window.electronAPI.getApiKeys();

  if (keys.claudeApiKey) {
    document.getElementById('claude-key-status').textContent = 'Configured';
    document.getElementById('claude-key-status').style.color = 'var(--success)';
  }

  if (keys.openaiApiKey) {
    document.getElementById('openai-key-status').textContent = 'Configured';
    document.getElementById('openai-key-status').style.color = 'var(--success)';
  }
}

// ============================================================================
// EVENT LISTENERS
// ============================================================================

function setupEventListeners() {
  // Theme toggle
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  // Settings button
  document.getElementById('settings-btn').addEventListener('click', () => {
    switchTab('settings');
  });

  // Tabs
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Load audio file
  document.getElementById('load-audio-btn').addEventListener('click', loadAudioFile);

  // Processing
  document.getElementById('transcribe-btn').addEventListener('click', transcribeAudio);
  document.getElementById('generate-btn').addEventListener('click', generateNotes);
  document.getElementById('save-btn').addEventListener('click', saveNotes);

  // Copy buttons
  document.getElementById('copy-transcript').addEventListener('click', () => copyToClipboard(transcript, 'Transcript'));
  document.getElementById('copy-notes').addEventListener('click', () => copyToClipboard(meetingNotes, 'Notes'));

  // Settings
  document.getElementById('ai-provider').addEventListener('change', updateProviderUI);
  document.getElementById('check-ollama').addEventListener('click', checkOllama);
  document.getElementById('save-claude-key').addEventListener('click', () => saveApiKey('claude'));
  document.getElementById('save-openai-key').addEventListener('click', () => saveApiKey('openai'));
  document.getElementById('save-settings').addEventListener('click', saveSettings);

  // Modal
  document.getElementById('confirm-cancel').addEventListener('click', hideModal);
}

function setupProgressListeners() {
  window.electronAPI.onTranscriptionProgress((data) => {
    updateProgress(data.percent, 100, data.message, 'Transcribing');
  });
}

// ============================================================================
// THEME
// ============================================================================

function toggleTheme() {
  const currentTheme = document.body.getAttribute('data-theme');
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  document.body.setAttribute('data-theme', newTheme);
  localStorage.setItem('boardnotes-theme', newTheme);
}

// ============================================================================
// TABS
// ============================================================================

function switchTab(tabName) {
  // Update tab buttons
  document.querySelectorAll('.tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  });

  // Update tab content
  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.add('hidden');
  });
  document.getElementById(`${tabName}-tab`).classList.remove('hidden');
}

// ============================================================================
// LOAD AUDIO FILE
// ============================================================================

async function loadAudioFile() {
  const filePath = await window.electronAPI.selectAudioFile();
  if (filePath) {
    currentAudioPath = filePath;
    const fileName = filePath.split(/[/\\]/).pop();

    document.getElementById('audio-file-path').value = fileName;
    document.getElementById('transcribe-btn').disabled = false;

    // Reset previous results
    transcript = '';
    meetingNotes = '';
    document.getElementById('transcript-output').innerHTML = '<p class="text-tertiary">Transcript will appear here after transcription...</p>';
    document.getElementById('notes-output').innerHTML = '<p class="text-tertiary">Meeting notes will appear here after generation...</p>';
    document.getElementById('copy-transcript').disabled = true;
    document.getElementById('copy-notes').disabled = true;
    document.getElementById('generate-btn').disabled = true;
    document.getElementById('save-btn').disabled = true;

    // Reset steps
    for (let i = 1; i <= 3; i++) {
      document.getElementById(`step-${i}`).classList.remove('active', 'completed');
    }

    showToast('success', 'File Loaded', `Ready to transcribe: ${fileName}`);
  }
}

// ============================================================================
// TRANSCRIPTION
// ============================================================================

async function transcribeAudio() {
  if (!currentAudioPath) {
    showToast('error', 'Error', 'Please load an audio file first');
    return;
  }

  const btn = document.getElementById('transcribe-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Transcribing...';

  setStepActive(1);
  showProgress();
  updateProgress(0, 100, 'Loading Whisper model...', 'Whisper');

  // Start animated progress for transcription with varied messages
  let fakeProgress = 0;
  const progressMessages = [
    'Loading Whisper model...',
    'Processing audio file...',
    'Analyzing speech patterns...',
    'Converting speech to text...',
    'Recognizing words...',
    'Finalizing transcript...'
  ];
  let messageIndex = 0;

  const progressInterval = setInterval(() => {
    if (fakeProgress < 90) {
      fakeProgress += Math.random() * 2;
      if (fakeProgress > (messageIndex + 1) * 15 && messageIndex < progressMessages.length - 1) {
        messageIndex++;
      }
      updateProgress(Math.min(fakeProgress, 90), 100, progressMessages[messageIndex], 'Whisper');
    }
  }, 500);

  try {
    const result = await window.electronAPI.transcribeAudio(currentAudioPath, config.whisperModel);
    clearInterval(progressInterval);
    updateProgress(100, 100, 'Transcription complete!', 'Whisper');

    transcript = result.transcript;

    document.getElementById('transcript-output').textContent = transcript;
    document.getElementById('copy-transcript').disabled = false;

    setStepCompleted(1);
    document.getElementById('generate-btn').disabled = false;

    showToast('success', 'Transcription Complete', 'Audio has been transcribed successfully');
  } catch (error) {
    clearInterval(progressInterval);
    showToast('error', 'Transcription Failed', error.message);
    setStepActive(0);
  } finally {
    setTimeout(() => hideProgress(), 1000);
    btn.disabled = false;
    btn.innerHTML = 'Transcribe';
  }
}

// ============================================================================
// MEETING NOTES GENERATION
// ============================================================================

async function generateNotes() {
  if (!transcript) {
    showToast('error', 'Error', 'Please transcribe audio first');
    return;
  }

  const btn = document.getElementById('generate-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Generating...';

  setStepActive(2);
  showProgress();
  updateProgress(0, 100, 'Connecting to AI...', 'AI');

  // Start animated progress for AI generation
  let fakeProgress = 0;
  const progressMessages = [
    'Connecting to AI...',
    'Analyzing transcript...',
    'Identifying key topics...',
    'Extracting action items...',
    'Formatting meeting notes...',
    'Finalizing notes...'
  ];
  let messageIndex = 0;

  const progressInterval = setInterval(() => {
    if (fakeProgress < 90) {
      fakeProgress += Math.random() * 3;
      if (fakeProgress > (messageIndex + 1) * 15 && messageIndex < progressMessages.length - 1) {
        messageIndex++;
      }
      updateProgress(Math.min(fakeProgress, 90), 100, progressMessages[messageIndex], 'AI');
    }
  }, 400);

  try {
    const result = await window.electronAPI.generateMeetingNotes(transcript, {
      provider: config.aiProvider,
      model: config.aiModel,
      ollamaHost: config.ollamaHost
    });

    clearInterval(progressInterval);
    updateProgress(100, 100, 'Notes generated!', 'AI');

    meetingNotes = result.notes;

    document.getElementById('notes-output').textContent = meetingNotes;
    document.getElementById('copy-notes').disabled = false;

    setStepCompleted(2);
    document.getElementById('save-btn').disabled = false;

    showToast('success', 'Generation Complete', `Notes generated using ${result.provider}/${result.model}`);
  } catch (error) {
    clearInterval(progressInterval);
    showToast('error', 'Generation Failed', error.message);
    setStepActive(1);
  } finally {
    setTimeout(() => hideProgress(), 1000);
    btn.disabled = false;
    btn.innerHTML = 'Generate';
  }
}

// ============================================================================
// SAVE NOTES
// ============================================================================

async function saveNotes() {
  if (!meetingNotes) {
    showToast('error', 'Error', 'No notes to save');
    return;
  }

  // Use save dialog to let user choose location and filename
  const result = await window.electronAPI.saveNotesDialog(meetingNotes, outputDirectory);

  if (result.success) {
    setStepCompleted(3);
    showToast('success', 'Saved', `Notes saved successfully`);
    if (result.folderPath) {
      await window.electronAPI.openFolder(result.folderPath);
    }
  } else if (result.error) {
    showToast('error', 'Save Failed', result.error);
  }
  // If canceled, do nothing
}

// ============================================================================
// PROCESSING STEPS UI
// ============================================================================

function setStepActive(stepNum) {
  for (let i = 1; i <= 3; i++) {
    const step = document.getElementById(`step-${i}`);
    step.classList.remove('active', 'completed');
    if (i === stepNum) {
      step.classList.add('active');
    } else if (i < stepNum) {
      step.classList.add('completed');
    }
  }
}

function setStepCompleted(stepNum) {
  const step = document.getElementById(`step-${stepNum}`);
  step.classList.remove('active');
  step.classList.add('completed');
}

// ============================================================================
// SETTINGS
// ============================================================================

let cachedOllamaModels = [];

async function updateProviderUI() {
  const provider = document.getElementById('ai-provider').value;
  const ollamaHostGroup = document.getElementById('ollama-host-group');
  const modelSelect = document.getElementById('ai-model');

  ollamaHostGroup.classList.toggle('hidden', provider !== 'ollama');

  const cloudModels = {
    claude: [
      { value: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet (Recommended)' },
      { value: 'claude-3-haiku', label: 'Claude 3 Haiku (Fast)' },
      { value: 'claude-3-opus', label: 'Claude 3 Opus (Best)' }
    ],
    openai: [
      { value: 'gpt-4o', label: 'GPT-4o (Recommended)' },
      { value: 'gpt-4o-mini', label: 'GPT-4o Mini (Fast)' },
      { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' }
    ]
  };

  if (provider === 'ollama') {
    await refreshOllamaModels();
  } else {
    modelSelect.innerHTML = cloudModels[provider].map(m =>
      `<option value="${m.value}">${m.label}</option>`
    ).join('');
  }

  config.aiProvider = provider;
}

async function refreshOllamaModels() {
  const host = document.getElementById('ollama-host').value;
  const modelSelect = document.getElementById('ai-model');

  try {
    const result = await window.electronAPI.checkOllama(host);
    if (result.connected && result.models.length > 0) {
      cachedOllamaModels = result.models;
      modelSelect.innerHTML = result.models.map(m =>
        `<option value="${m.id}">${m.name}</option>`
      ).join('');
    } else {
      modelSelect.innerHTML = '<option value="">No models found - check Ollama connection</option>';
    }
  } catch (error) {
    modelSelect.innerHTML = '<option value="">Could not connect to Ollama</option>';
  }
}

async function checkOllama() {
  const host = document.getElementById('ollama-host').value;
  const btn = document.getElementById('check-ollama');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';

  try {
    const result = await window.electronAPI.checkOllama(host);
    if (result.connected) {
      showToast('success', 'Connected', `Found ${result.models.length} model(s)`);
      await refreshOllamaModels();
    } else {
      showToast('error', 'Not Connected', 'Could not connect to Ollama');
    }
  } catch (error) {
    showToast('error', 'Error', error.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Check';
  }
}

async function saveApiKey(provider) {
  const inputId = provider === 'claude' ? 'claude-key' : 'openai-key';
  const statusId = provider === 'claude' ? 'claude-key-status' : 'openai-key-status';
  const apiKey = document.getElementById(inputId).value.trim();

  if (!apiKey) {
    showToast('error', 'Error', 'Please enter an API key');
    return;
  }

  try {
    const result = await window.electronAPI.saveApiKey(provider, apiKey);
    if (result.success) {
      document.getElementById(statusId).textContent = 'Configured';
      document.getElementById(statusId).style.color = 'var(--success)';
      document.getElementById(inputId).value = '';
      showToast('success', 'Saved', `${provider.charAt(0).toUpperCase() + provider.slice(1)} API key saved`);
    } else {
      showToast('error', 'Error', result.error);
    }
  } catch (error) {
    showToast('error', 'Error', error.message);
  }
}

async function saveSettings() {
  config.aiProvider = document.getElementById('ai-provider').value;
  config.aiModel = document.getElementById('ai-model').value;
  config.ollamaHost = document.getElementById('ollama-host').value;
  config.whisperModel = document.getElementById('whisper-model').value;

  try {
    const result = await window.electronAPI.saveConfig(config);
    if (result.success) {
      showToast('success', 'Saved', 'Settings saved successfully');
    } else {
      showToast('error', 'Error', result.error);
    }
  } catch (error) {
    showToast('error', 'Error', error.message);
  }
}

// ============================================================================
// UTILITIES
// ============================================================================

function copyToClipboard(text, name) {
  navigator.clipboard.writeText(text).then(() => {
    showToast('success', 'Copied', `${name} copied to clipboard`);
  }).catch(err => {
    showToast('error', 'Error', 'Failed to copy to clipboard');
  });
}

// ============================================================================
// PROGRESS
// ============================================================================

function showProgress() {
  document.getElementById('progress-container').classList.remove('hidden');
}

function hideProgress() {
  document.getElementById('progress-container').classList.add('hidden');
  document.getElementById('progress-fill').style.width = '0%';
}

function updateProgress(current, total, filename, action) {
  const percent = Math.round((current / total) * 100);
  document.getElementById('progress-fill').style.width = `${percent}%`;
  document.getElementById('progress-percent').textContent = `${percent}%`;
  document.getElementById('progress-status').textContent = `${action}: ${filename}`;
}

// ============================================================================
// TOAST
// ============================================================================

function showToast(type, title, message) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <div class="toast-title">${title}</div>
    <div class="toast-message">${message}</div>
  `;
  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 5000);
}

// ============================================================================
// MODAL
// ============================================================================

let confirmCallback = null;

function showConfirm(title, message, callback) {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-message').textContent = message;
  document.getElementById('confirm-modal').classList.add('show');
  confirmCallback = callback;

  document.getElementById('confirm-ok').onclick = () => {
    hideModal();
    if (confirmCallback) confirmCallback();
  };
}

function hideModal() {
  document.getElementById('confirm-modal').classList.remove('show');
  confirmCallback = null;
}
