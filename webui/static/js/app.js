// webui/static/js/app.js

// Global variables
let currentJobId = null;
let progressTimer = null;
let currentFileBrowserPath = '/Volumes/Callisto/Movies';
let selectedFilePath = null;
let fileBrowserTarget = null;
let projectAudioSources = {};
let browserMode = 'master';

// Theme management
function toggleTheme() {
    const body = document.body;
    const currentTheme = body.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    body.setAttribute('data-theme', newTheme);
    
    const themeToggle = document.querySelector('.theme-toggle');
    themeToggle.textContent = newTheme === 'dark' ? '☀️' : '🌙';
    
    localStorage.setItem('theme', newTheme);
}

// Load saved theme on page load
document.addEventListener('DOMContentLoaded', function() {
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.body.setAttribute('data-theme', savedTheme);
    document.querySelector('.theme-toggle').textContent = savedTheme === 'dark' ? '☀️' : '🌙';
});

// XML Generation Options
function selectAllXmlOptions() {
    const checkboxes = document.querySelectorAll('input[name="xmlOptions"]');
    checkboxes.forEach(checkbox => checkbox.checked = true);
}

function deselectAllXmlOptions() {
    const checkboxes = document.querySelectorAll('input[name="xmlOptions"]');
    checkboxes.forEach(checkbox => checkbox.checked = false);
}

function getSelectedXmlOptions() {
    const checkboxes = document.querySelectorAll('input[name="xmlOptions"]:checked');
    const selected = Array.from(checkboxes).map(cb => cb.value);
    return selected.length > 0 ? selected : null;
}

// Audio source management
function openAudioFileBrowser() {
    browserMode = 'audio';
    fileBrowserTarget = 'audio';
    selectedFilePath = null;
    document.getElementById('modalTitle').textContent = '📁 Select Audio/Video File';
    document.getElementById('fileBrowserModal').classList.remove('hidden');
    document.getElementById('selectFileBtn').classList.remove('hidden');
    document.getElementById('selectFileBtn').disabled = true;
    document.getElementById('selectFileBtn').textContent = 'Add to Project';
    loadFileBrowserPath(currentFileBrowserPath);
}

function getAudioTypeLabel(audioType) {
    const labels = {
        'mic1': 'Mic Audio 1',
        'mic2': 'Mic Audio 2',
        'mic3': 'Mic Audio 3',
        'mic4': 'Mic Audio 4',
        'screen': 'Screen Audio',
        'game': 'Game Audio',
        'sound_effects': 'Sound Effects',
        'soundEffects': 'Sound Effects',
        'bluetooth': 'Bluetooth Audio'
    };
    return labels[audioType] || audioType;
}

function updateProjectAudioList() {
    const container = document.getElementById('projectAudioList');
    
    if (Object.keys(projectAudioSources).length === 0) {
        container.innerHTML = '<p class="form-help">No audio sources added yet. Use auto-detect or add manually.</p>';
        return;
    }
    
    let html = '';
    for (const [id, source] of Object.entries(projectAudioSources)) {
        const fileName = source.path.split('/').pop();
        const syncCheckboxId = `sync${id}`;
        
        // Create dropdown options
        const audioTypes = [
            {value: '', label: 'Select Type...'},
            {value: 'mic1', label: 'Mic Audio 1'},
            {value: 'mic2', label: 'Mic Audio 2'},
            {value: 'mic3', label: 'Mic Audio 3'},
            {value: 'mic4', label: 'Mic Audio 4'},
            {value: 'screen', label: 'Screen Audio'},
            {value: 'game', label: 'Game Audio'},
            {value: 'sound_effects', label: 'Sound Effects'},
            {value: 'bluetooth', label: 'Bluetooth Audio'}
        ];
        
        // Check if type is already in use by another file
        const usedTypes = Object.values(projectAudioSources)
            .filter(s => s !== source && s.type)
            .map(s => s.type);
        
        html += `
            <div class="project-audio-item ${!source.type ? 'unassigned' : ''}" data-id="${id}">
                <div class="audio-item-info">
                    <div class="audio-item-path" title="${source.path}">${fileName}</div>
                </div>
                <div class="audio-item-controls">
                    <select class="audio-type-select" onchange="assignAudioType('${id}', this.value)">
                        ${audioTypes.map(opt => {
                            const disabled = (opt.value && usedTypes.includes(opt.value)) ? 'disabled' : '';
                            const selected = source.type === opt.value ? 'selected' : '';
                            return `<option value="${opt.value}" ${disabled} ${selected}>${opt.label}${disabled ? ' (in use)' : ''}</option>`;
                        }).join('')}
                    </select>
                    <label class="checkbox-label">
                        <input type="checkbox" id="${syncCheckboxId}" ${source.syncFix ? 'checked' : ''} 
                               onchange="updateAudioSyncSetting('${id}', this.checked)"
                               ${!source.type ? 'disabled' : ''}>
                        <span class="checkbox-custom"></span>
                        29.97fps
                    </label>
                    <button type="button" class="btn btn-small btn-danger" onclick="removeAudioSource('${id}')">
                        Remove
                    </button>
                </div>
            </div>
        `;
    }
    
    container.innerHTML = html;
}

function assignAudioType(fileId, audioType) {
    if (!projectAudioSources[fileId]) return;
    
    // Clear the type if empty string
    if (!audioType) {
        projectAudioSources[fileId].type = null;
        updateProjectAudioList();
        return;
    }
    
    // Check if this type is already assigned to another file
    for (const [id, source] of Object.entries(projectAudioSources)) {
        if (id !== fileId && source.type === audioType) {
            showAlert('warning', `${getAudioTypeLabel(audioType)} is already assigned to another file`);
            // Reset the dropdown
            updateProjectAudioList();
            return;
        }
    }
    
    // Assign the type
    projectAudioSources[fileId].type = audioType;
    updateProjectAudioList();
    showAlert('success', `Assigned as ${getAudioTypeLabel(audioType)}`);
}

function updateAudioSyncSetting(fileId, syncEnabled) {
    if (projectAudioSources[fileId]) {
        projectAudioSources[fileId].syncFix = syncEnabled;
    }
}

function removeAudioSource(fileId) {
    delete projectAudioSources[fileId];
    updateProjectAudioList();
}

async function autoDetectAudioFiles() {
    const masterPath = document.getElementById('masterVideoPath').value;
    if (!masterPath) {
        showAlert('warning', 'Please select a master video file first');
        return;
    }
    
    try {
        const response = await fetch(`/api/auto-detect-audio?masterPath=${encodeURIComponent(masterPath)}`);
        const result = await response.json();
        
        if (result.success) {
            // Add detected files with proper types
            for (const [type, path] of Object.entries(result.audioFiles)) {
                const fileId = 'file_' + Date.now() + '_' + type;
                projectAudioSources[fileId] = {
                    path: path,
                    type: type === 'soundEffects' ? 'sound_effects' : type,
                    syncFix: false
                };
            }
            
            updateProjectAudioList();
            showAlert('success', `Auto-detected ${Object.keys(result.audioFiles).length} audio files`);
        } else {
            showAlert('warning', `Could not auto-detect audio files: ${result.error}`);
        }
    } catch (error) {
        showAlert('warning', `Error detecting audio files: ${error.message}`);
    }
}

// Form data collection
function getFormData() {
    const form = document.getElementById('videoForm');
    const formData = new FormData(form);
    
    const audioSources = {};
    const audioSyncSettings = {};
    
    // Convert from file IDs to audio types
    for (const [id, source] of Object.entries(projectAudioSources)) {
        if (source.type) {  // Only include files with assigned types
            const audioKey = source.type === 'sound_effects' ? 'soundEffectsAudio' : `${source.type}Audio`;
            audioSources[audioKey] = source.path;
            audioSyncSettings[source.type] = source.syncFix || false;
        }
    }
    
    const xmlOptions = getSelectedXmlOptions();
    
    const data = {
        masterVideo: document.getElementById('masterVideoPath').value,
        threshold: formData.get('threshold'),
        audioSyncSettings: audioSyncSettings,
        xmlOptions: xmlOptions,
        ...audioSources
    };
    
    return data;
}

// Alert system
function showAlert(type, message, autoClose = true) {
    const alertsContainer = document.getElementById('alertsContainer');
    const alertId = 'alert-' + Date.now();
    
    const alertHTML = `
        <div class="alert alert-${type}" id="${alertId}">
            <div>
                ${type === 'success' ? '✅' : 
                  type === 'warning' ? '⚠️' : 
                  type === 'danger' ? '❌' : 'ℹ️'}
            </div>
            <div>${message}</div>
            <button class="alert-close" onclick="closeAlert('${alertId}')">×</button>
        </div>
    `;
    
    alertsContainer.insertAdjacentHTML('beforeend', alertHTML);
    
    if (autoClose) {
        setTimeout(() => closeAlert(alertId), 5000);
    }
}

function closeAlert(alertId) {
    const alert = document.getElementById(alertId);
    if (alert) {
        alert.remove();
    }
}

// Form validation
function validateForm() {
    const masterVideo = document.getElementById('masterVideoPath').value.trim();
    
    if (!masterVideo) {
        showAlert('danger', 'Master video file is required');
        return false;
    }
    
    // Check for unassigned audio files
    const unassignedFiles = Object.values(projectAudioSources).filter(s => !s.type);
    if (unassignedFiles.length > 0) {
        showAlert('warning', `${unassignedFiles.length} audio file(s) have no type assigned. They will not be included in processing.`);
    }
    
    if (Object.keys(projectAudioSources).length === 0) {
        showAlert('warning', 'At least one audio source is recommended for generating compound clips');
    }
    
    return true;
}

// Test configuration
async function testConfig() {
    const testBtn = document.getElementById('testBtn');
    testBtn.disabled = true;
    testBtn.textContent = 'Testing...';
    
    try {
        const response = await fetch('/api/test-config');
        const result = await response.json();
        
        if (result.success) {
            showAlert('success', `Configuration loaded successfully! Using ${result.configPath}`);
        } else {
            showAlert('danger', `Configuration error: ${result.error}`);
        }
    } catch (error) {
        showAlert('danger', `Failed to test configuration: ${error.message}`);
    } finally {
        testBtn.disabled = false;
        testBtn.textContent = '🧪 Test Configuration';
    }
}

// Start processing
async function startProcessing() {
    if (!validateForm()) {
        return;
    }
    
    const formData = getFormData();
    const processBtn = document.getElementById('processBtn');
    
    processBtn.disabled = true;
    processBtn.textContent = 'Starting...';
    
    try {
        const response = await fetch('/api/process', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(formData)
        });
        
        const result = await response.json();
        
        if (result.success) {
            currentJobId = result.jobId;
            showProgressSection();
            startProgressPolling();
            showAlert('info', 'Processing started successfully!');
        } else {
            showAlert('danger', `Failed to start processing: ${result.error}`);
            processBtn.disabled = false;
            processBtn.textContent = '🚀 Start Processing';
        }
    } catch (error) {
        showAlert('danger', `Error starting processing: ${error.message}`);
        processBtn.disabled = false;
        processBtn.textContent = '🚀 Start Processing';
    }
}

// Progress management
function showProgressSection() {
    document.getElementById('progressSection').classList.remove('hidden');
    document.getElementById('resultsSection').classList.add('hidden');
    
    document.getElementById('progressSection').scrollIntoView({ 
        behavior: 'smooth',
        block: 'start'
    });
}

function startProgressPolling() {
    if (progressTimer) {
        clearInterval(progressTimer);
    }
    
    progressTimer = setInterval(checkProgress, 1000);
    checkProgress();
}

async function checkProgress() {
    if (!currentJobId) return;
    
    try {
        const response = await fetch(`/api/job/${currentJobId}`);
        const job = await response.json();
        
        updateProgress(job);
        
        if (job.status === 'completed') {
            clearInterval(progressTimer);
            showResults(job);
        } else if (job.status === 'error') {
            clearInterval(progressTimer);
            showError(job);
        }
    } catch (error) {
        console.error('Error checking progress:', error);
        showAlert('warning', 'Lost connection to server, retrying...');
    }
}

function updateProgress(job) {
    const progressBar = document.getElementById('progressBar');
    const progressMessage = document.getElementById('progressMessage');
    const statusBadge = document.getElementById('statusBadge');
    
    progressBar.style.width = `${job.progress}%`;
    progressMessage.textContent = job.message;
    
    if (job.status === 'processing') {
        statusBadge.className = 'badge badge-info';
        statusBadge.textContent = 'Processing';
    } else if (job.status === 'completed') {
        statusBadge.className = 'badge badge-success';
        statusBadge.textContent = 'Completed';
    } else if (job.status === 'error') {
        statusBadge.className = 'badge badge-danger';
        statusBadge.textContent = 'Error';
    }
}

// Results display
function showResults(job) {
    document.getElementById('resultsSection').classList.remove('hidden');
    
    const resultsContainer = document.getElementById('resultsContainer');
    
    if (job.results && job.results.length > 0) {
        const zipFile = job.results.find(r => r.type === 'zip');
        const otherFiles = job.results.filter(r => r.type !== 'zip');
        
        let resultsHTML = '';
        
        if (zipFile) {
            resultsHTML += `
                <div class="result-card zip-card mb-3">
                    <h4>📦 ${zipFile.name}</h4>
                    <p class="result-description">${zipFile.description}</p>
                    <div class="result-meta mb-2">
                        <span class="result-type zip-type">ZIP ARCHIVE</span>
                    </div>
                    <button class="btn btn-primary zip-download" onclick="downloadFile('${zipFile.path}')">
                        Download All XML Files
                    </button>
                </div>
            `;
        }
        
        if (otherFiles.length > 0) {
            resultsHTML += '<h3 class="mb-2">Individual Files (also included in zip)</h3>';
            resultsHTML += '<div class="grid grid-3">';
            
            otherFiles.forEach(result => {
                resultsHTML += `
                    <div class="result-card">
                        <h4>${result.name}</h4>
                        <p class="result-description">${result.description}</p>
                        <div class="result-meta">
                            <span class="result-type">${result.type.toUpperCase()}</span>
                        </div>
                        <button class="btn btn-secondary" onclick="downloadFile('${result.path}')">
                            Download XML
                        </button>
                    </div>
                `;
            });
            
            resultsHTML += '</div>';
        }
        
        resultsContainer.innerHTML = resultsHTML;
    } else {
        resultsContainer.innerHTML = `
            <div class="alert alert-warning">
                <div>⚠️</div>
                <div>No files were generated. Check your settings and try again.</div>
            </div>
        `;
    }
    
    document.getElementById('resultsSection').scrollIntoView({ 
        behavior: 'smooth',
        block: 'start'
    });
    
    showAlert('success', `Processing completed! Generated ${job.results.length} files.`);
    
    // Re-enable the process button for new jobs
    const processBtn = document.getElementById('processBtn');
    processBtn.disabled = false;
    processBtn.textContent = '🚀 Start Processing';
}

function showError(job) {
    const resultsContainer = document.getElementById('resultsContainer');
    resultsContainer.innerHTML = `
        <div class="alert alert-danger">
            <div>❌</div>
            <div>
                <strong>Processing failed:</strong><br>
                ${job.error || job.message}
            </div>
        </div>
    `;
    
    document.getElementById('resultsSection').classList.remove('hidden');
    document.getElementById('resultsSection').scrollIntoView({ 
        behavior: 'smooth',
        block: 'start'
    });
    
    showAlert('danger', `Processing failed: ${job.error || job.message}`);
    
    // Re-enable process button
    const processBtn = document.getElementById('processBtn');
    processBtn.disabled = false;
    processBtn.textContent = '🚀 Start Processing';
}

// File download
function downloadFile(filePath) {
    const encodedPath = encodeURIComponent(filePath);
    const link = document.createElement('a');
    link.href = `/api/download/${encodedPath}`;
    link.download = filePath.split('/').pop();
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    showAlert('info', 'Download started!');
}

// Form reset
function resetForm() {
    document.getElementById('videoForm').reset();
    document.getElementById('progressSection').classList.add('hidden');
    document.getElementById('resultsSection').classList.add('hidden');
    
    projectAudioSources = {};
    updateProjectAudioList();
    
    deselectAllXmlOptions();
    
    const processBtn = document.getElementById('processBtn');
    processBtn.disabled = false;
    processBtn.textContent = '🚀 Start Processing';
    
    currentJobId = null;
    
    if (progressTimer) {
        clearInterval(progressTimer);
        progressTimer = null;
    }
    
    document.getElementById('alertsContainer').innerHTML = '';
    
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// File browser functions
function openFileBrowser(targetInput = 'masterVideo') {
    fileBrowserTarget = targetInput;
    browserMode = 'master';
    selectedFilePath = null;
    document.getElementById('modalTitle').textContent = '📁 File Browser';
    document.getElementById('fileBrowserModal').classList.remove('hidden');
    document.getElementById('selectFileBtn').classList.remove('hidden');
    document.getElementById('selectFileBtn').disabled = true;
    document.getElementById('selectFileBtn').textContent = 'Select File';
    loadFileBrowserPath(currentFileBrowserPath);
}

function closeFileBrowser() {
    document.getElementById('fileBrowserModal').classList.add('hidden');
    selectedFilePath = null;
    fileBrowserTarget = null;
    browserMode = 'master';
}

async function loadFileBrowserPath(path) {
    const fileList = document.getElementById('fileList');
    const breadcrumb = document.getElementById('breadcrumb');
    
    fileList.innerHTML = '<div class="loading">Loading files...</div>';
    breadcrumb.textContent = path;
    
    const url = `/api/browse?path=${encodeURIComponent(path)}`;
    
    try {
        const response = await fetch(url);
        const result = await response.json();
        
        if (result.success) {
            currentFileBrowserPath = result.currentPath;
            renderFileList(result.items);
        } else {
            fileList.innerHTML = `<div class="loading">Error: ${result.error}</div>`;
        }
    } catch (error) {
        fileList.innerHTML = `<div class="loading">Error loading files: ${error.message}</div>`;
    }
}

function renderFileList(items) {
    const fileList = document.getElementById('fileList');
    
    if (items.length === 0) {
        fileList.innerHTML = '<div class="loading">No files found</div>';
        return;
    }
    
    let html = '';
    items.forEach(item => {
        const icon = getFileIcon(item.type);
        const isSelectable = (browserMode === 'master' && item.type === 'video') || 
                           (browserMode === 'audio' && (item.type === 'audio' || item.type === 'video'));
        
        html += `
            <div class="file-item ${isSelectable ? 'selectable' : ''}" 
                 data-path="${item.path}" 
                 data-type="${item.type}"
                 onclick="handleFileClick('${item.path}', '${item.type}')">
                <div class="file-icon">${icon}</div>
                <div class="file-info">
                    <div class="file-name">${item.name}</div>
                    <div class="file-details">
                        ${item.type === 'directory' ? 'Folder' : 
                          item.type === 'video' ? `Video • ${item.sizeFormatted}` :
                          item.type === 'audio' ? `Audio • ${item.sizeFormatted}` : ''}
                    </div>
                </div>
            </div>
        `;
    });
    
    fileList.innerHTML = html;
}

function getFileIcon(type) {
    switch (type) {
        case 'directory': return '📁';
        case 'video': return '🎬';
        case 'audio': return '🎵';
        default: return '📄';
    }
}

function handleFileClick(path, type) {
    document.querySelectorAll('.file-item').forEach(item => {
        item.classList.remove('selected');
    });
    
    if (type === 'directory') {
        loadFileBrowserPath(path);
    } else if ((browserMode === 'master' && type === 'video') || 
               (browserMode === 'audio' && (type === 'audio' || type === 'video'))) {
        selectedFilePath = path;
        event.target.closest('.file-item').classList.add('selected');
        document.getElementById('selectFileBtn').disabled = false;
    }
}

function selectCurrentFile() {
    if (!selectedFilePath) return;
    
    if (fileBrowserTarget === 'masterVideo') {
        document.getElementById('masterVideoPath').value = selectedFilePath;
        closeFileBrowser();
    } else if (fileBrowserTarget === 'audio') {
        // Add file to project as unassigned
        const fileId = 'file_' + Date.now();
        const fileName = selectedFilePath.split('/').pop();
        
        // Check if file already exists
        for (const [id, source] of Object.entries(projectAudioSources)) {
            if (source.path === selectedFilePath) {
                showAlert('warning', 'This file is already in the project');
                closeFileBrowser();
                return;
            }
        }
        
        // Add as unassigned
        projectAudioSources[fileId] = {
            path: selectedFilePath,
            type: null,  // No type assigned yet
            syncFix: false
        };
        
        updateProjectAudioList();
        closeFileBrowser();
        showAlert('info', `Added ${fileName} to project. Please select its audio type.`);
    }
}