// webui/static/js/app.js

// Global variables
let currentJobId = null;
let progressTimer = null;
let currentFileBrowserPath = '/Volumes/Callisto/Movies';
let selectedFilePath = null;
let fileBrowserTarget = null; // Which input field we're browsing for
let projectAudioSources = {}; // Store project audio sources: {type: {path: string, syncFix: boolean}}
let browserMode = 'master'; // 'master' or 'audio'

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

// Load saved theme and set up all event listeners
document.addEventListener('DOMContentLoaded', function() {
    // Theme setup
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.body.setAttribute('data-theme', savedTheme);
    document.querySelector('.theme-toggle').textContent = savedTheme === 'dark' ? '☀️' : '🌙';
    
    // Add file change listeners
    const fileInputs = document.querySelectorAll('input[type="file"]');
    fileInputs.forEach(input => {
        input.addEventListener('change', function() {
            const label = this.previousElementSibling;
            if (this.files.length > 0) {
                label.style.color = 'var(--primary-orange)';
            } else {
                label.style.color = '';
            }
        });
    });
    
    // Add click event listeners to replace onclick attributes
    
    // Theme toggle
    const themeToggle = document.querySelector('.theme-toggle');
    if (themeToggle) {
        themeToggle.addEventListener('click', toggleTheme);
    }
    
    // Main browse files button
    const mainBrowseBtn = document.querySelector('button[onclick*="openFileBrowser()"]');
    if (mainBrowseBtn) {
        mainBrowseBtn.addEventListener('click', function() {
            openFileBrowser();
        });
    }
    
    // Process and test buttons
    const processBtn = document.getElementById('processBtn');
    if (processBtn) {
        processBtn.addEventListener('click', startProcessing);
    }
    
    const testBtn = document.getElementById('testBtn');
    if (testBtn) {
        testBtn.addEventListener('click', testConfig);
    }
    
    // Modal buttons
    const modalClose = document.querySelector('.modal-close');
    if (modalClose) {
        modalClose.addEventListener('click', closeFileBrowser);
    }
    
    const selectFileBtn = document.getElementById('selectFileBtn');
    if (selectFileBtn) {
        selectFileBtn.addEventListener('click', selectCurrentFile);
    }
    
    // Reset form button (event delegation)
    document.addEventListener('click', function(e) {
        if (e.target.onclick && e.target.onclick.toString().includes('resetForm')) {
            resetForm();
        }
    });
});

// File path helpers
function getFilePathFromInput(input) {
    if (!input.files || input.files.length === 0) {
        return null;
    }
    return input.files[0].name; // In a real app, you'd need to handle file upload properly
}

function getFormData() {
    const form = document.getElementById('videoForm');
    const formData = new FormData(form);
    
    // Build audio sources and sync settings from project audio sources
    const audioSources = {};
    const audioSyncSettings = {};
    
    for (const [type, source] of Object.entries(projectAudioSources)) {
        audioSources[`${type}Audio`] = source.path;
        audioSyncSettings[type] = source.syncFix || false;
    }
    
    const data = {
        masterVideo: document.getElementById('masterVideoPath').value,
        threshold: formData.get('threshold'),
        audioSyncSettings: audioSyncSettings,
        ...audioSources
    };
    
    return data;
}

// Audio source management functions
function openAudioFileBrowser() {
    // Show the audio browser panel
    document.getElementById('audioBrowserPanel').style.display = 'block';
    document.getElementById('audioBrowserInactive').style.display = 'none';
    
    // Set browser mode and initialize
    browserMode = 'audio';
    fileBrowserTarget = 'audio';
    selectedFilePath = null;
    
    // Load the file browser in the audio panel
    loadAudioFileBrowserPath(currentFileBrowserPath);
}

function closeAudioBrowser() {
    document.getElementById('audioBrowserPanel').style.display = 'none';
    document.getElementById('audioBrowserInactive').style.display = 'block';
    selectedFilePath = null;
    browserMode = 'master';
}

async function loadAudioFileBrowserPath(path) {
    const fileList = document.getElementById('audioFileList');
    const breadcrumb = document.getElementById('audioBreadcrumb');
    
    fileList.innerHTML = '<div class="loading">Loading files...</div>';
    breadcrumb.textContent = path;
    
    const url = `/api/browse?path=${encodeURIComponent(path)}`;
    
    try {
        const response = await fetch(url);
        const result = await response.json();
        
        if (result.success) {
            currentFileBrowserPath = result.currentPath;
            renderAudioFileList(result.items);
        } else {
            fileList.innerHTML = `<div class="loading">Error: ${result.error}</div>`;
        }
    } catch (error) {
        fileList.innerHTML = `<div class="loading">Error loading files: ${error.message}</div>`;
    }
}

function renderAudioFileList(items) {
    const fileList = document.getElementById('audioFileList');
    
    if (items.length === 0) {
        fileList.innerHTML = '<div class="loading">No files found</div>';
        return;
    }
    
    let html = '';
    items.forEach(item => {
        const icon = getFileIcon(item.type);
        const isSelectable = item.type === 'audio' || item.type === 'video';
        
        html += `
            <div class="file-item ${isSelectable ? 'selectable' : ''}" 
                 data-path="${item.path}" 
                 data-type="${item.type}"
                 onclick="handleAudioFileClick('${item.path}', '${item.type}')">
                <div class="file-icon">${icon}</div>
                <div class="file-info">
                    <div class="file-name">${item.name}</div>
                    <div class="file-details">
                        ${item.type === 'directory' ? 'Folder' : 
                          item.type === 'audio' ? `Audio • ${item.sizeFormatted}` : 
                          item.type === 'video' ? `Video • ${item.sizeFormatted}` : ''}
                    </div>
                </div>
            </div>
        `;
    });
    
    fileList.innerHTML = html;
}

function handleAudioFileClick(path, type) {
    // Clear previous selections in audio browser
    document.querySelectorAll('#audioFileList .file-item').forEach(item => {
        item.classList.remove('selected');
    });
    
    if (type === 'directory') {
        // Navigate to directory
        loadAudioFileBrowserPath(path);
    } else if (type === 'audio' || type === 'video') {
        // Select audio or video file
        selectedFilePath = path;
        event.target.closest('.file-item').classList.add('selected');
        document.getElementById('addAudioFileBtn').disabled = false;
    }
}

function addSelectedAudioFile() {
    if (!selectedFilePath) return;
    
    // Show audio type selection modal or auto-detect type
    const fileName = selectedFilePath.split('/').pop().toLowerCase();
    let audioType = detectAudioType(fileName);
    
    if (!audioType) {
        // Show type selection dialog
        audioType = promptForAudioType();
        if (!audioType) return;
    }
    
    // Add to project
    projectAudioSources[audioType] = {
        path: selectedFilePath,
        syncFix: false
    };
    
    updateProjectAudioList();
    closeAudioBrowser();
    selectedFilePath = null;
    
    showAlert('success', `Added ${audioType} audio to project`);
}

function addSelectedAudioToProject() {
    if (!selectedFilePath) return;
    
    // Show audio type selection modal or auto-detect type
    const fileName = selectedFilePath.split('/').pop().toLowerCase();
    let audioType = detectAudioType(fileName);
    
    if (!audioType) {
        // Show type selection dialog
        audioType = promptForAudioType();
        if (!audioType) return;
    }
    
    // Add to project
    projectAudioSources[audioType] = {
        path: selectedFilePath,
        syncFix: false
    };
    
    updateProjectAudioList();
    closeFileBrowser();
    selectedFilePath = null;
}

function detectAudioType(fileName) {
    if (fileName.includes('mic 1') || fileName.includes('mic1') || fileName.includes('mic audio 1')) return 'mic1';
    if (fileName.includes('mic 2') || fileName.includes('mic2') || fileName.includes('mic audio 2')) return 'mic2';
    if (fileName.includes('mic 3') || fileName.includes('mic3') || fileName.includes('mic audio 3')) return 'mic3';
    if (fileName.includes('mic 4') || fileName.includes('mic4') || fileName.includes('mic audio 4')) return 'mic4';
    if (fileName.includes('screen')) return 'screen';
    if (fileName.includes('game')) return 'game';
    if (fileName.includes('sound effects') || fileName.includes('sfx')) return 'soundEffects';
    if (fileName.includes('bluetooth')) return 'bluetooth';
    if (fileName.includes('mic audio') && !fileName.match(/[1-4]/)) return 'mic1'; // Default mic
    return null;
}

function promptForAudioType() {
    const audioTypes = [
        {value: 'mic1', label: 'Mic Audio 1'},
        {value: 'mic2', label: 'Mic Audio 2'},
        {value: 'mic3', label: 'Mic Audio 3'},
        {value: 'mic4', label: 'Mic Audio 4'},
        {value: 'screen', label: 'Screen Audio'},
        {value: 'game', label: 'Game Audio'},
        {value: 'soundEffects', label: 'Sound Effects'},
        {value: 'bluetooth', label: 'Bluetooth Audio'}
    ];
    
    const typeList = audioTypes.map(t => `${t.value}: ${t.label}`).join('\n');
    const selected = prompt(`Select audio type for this file:\n\n${typeList}\n\nEnter the type (e.g., mic1, screen, game):`);
    
    if (selected && audioTypes.find(t => t.value === selected)) {
        return selected;
    }
    return null;
}

function updateProjectAudioList() {
    const container = document.getElementById('projectAudioList');
    
    if (Object.keys(projectAudioSources).length === 0) {
        container.innerHTML = '<p class="form-help">No audio sources added yet. Use the file browser or auto-detect to add sources.</p>';
        return;
    }
    
    const audioTypeLabels = {
        'mic1': 'Mic Audio 1',
        'mic2': 'Mic Audio 2',
        'mic3': 'Mic Audio 3',
        'mic4': 'Mic Audio 4',
        'screen': 'Screen Audio',
        'game': 'Game Audio',
        'soundEffects': 'Sound Effects',
        'bluetooth': 'Bluetooth Audio'
    };
    
    let html = '';
    for (const [type, source] of Object.entries(projectAudioSources)) {
        const fileName = source.path.split('/').pop();
        const syncCheckboxId = `sync${type}`;
        
        html += `
            <div class="project-audio-item" data-type="${type}">
                <div class="audio-item-info">
                    <div class="audio-item-type">${audioTypeLabels[type]}:</div>
                    <div class="audio-item-path" title="${source.path}">${fileName}</div>
                </div>
                <div class="audio-item-controls">
                    <label class="checkbox-label">
                        <input type="checkbox" id="${syncCheckboxId}" ${source.syncFix ? 'checked' : ''} 
                               onchange="updateAudioSyncSetting('${type}', this.checked)">
                        <span class="checkbox-custom"></span>
                        29.97fps sync fix
                    </label>
                    <button type="button" class="btn btn-small btn-danger" onclick="removeAudioSource('${type}')">
                        Remove
                    </button>
                </div>
            </div>
        `;
    }
    
    container.innerHTML = html;
}

function updateAudioSyncSetting(audioType, syncEnabled) {
    if (projectAudioSources[audioType]) {
        projectAudioSources[audioType].syncFix = syncEnabled;
    }
}

function removeAudioSource(audioType) {
    delete projectAudioSources[audioType];
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
            // Add detected files to project sources
            for (const [type, path] of Object.entries(result.audioFiles)) {
                projectAudioSources[type] = {
                    path: path,
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

// Show progress section
function showProgressSection() {
    document.getElementById('progressSection').classList.remove('hidden');
    document.getElementById('resultsSection').classList.add('hidden');
    
    // Scroll to progress section
    document.getElementById('progressSection').scrollIntoView({ 
        behavior: 'smooth',
        block: 'start'
    });
}

// Start progress polling
function startProgressPolling() {
    if (progressTimer) {
        clearInterval(progressTimer);
    }
    
    progressTimer = setInterval(checkProgress, 1000);
    checkProgress(); // Check immediately
}

// Check progress
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

// Update progress display
function updateProgress(job) {
    const progressBar = document.getElementById('progressBar');
    const progressMessage = document.getElementById('progressMessage');
    const statusBadge = document.getElementById('statusBadge');
    
    progressBar.style.width = `${job.progress}%`;
    progressMessage.textContent = job.message;
    
    // Update status badge
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

// Show results
function showResults(job) {
    document.getElementById('resultsSection').classList.remove('hidden');
    
    const resultsContainer = document.getElementById('resultsContainer');
    
    if (job.results && job.results.length > 0) {
        let resultsHTML = '<div class="grid grid-3">';
        
        job.results.forEach(result => {
            resultsHTML += `
                <div class="result-card">
                    <h4>${result.name}</h4>
                    <p class="result-description">${result.description}</p>
                    <div class="result-meta">
                        <span class="result-type">${result.type.toUpperCase()}</span>
                    </div>
                    <button class="btn btn-primary" onclick="downloadFile('${result.path}')">
                        💾 Download XML
                    </button>
                </div>
            `;
        });
        
        resultsHTML += '</div>';
        
        // Add usage instructions
        resultsHTML += `
            <div class="usage-instructions">
                <h3>How to Use Your Compound Clips</h3>
                <div class="instruction-grid">
                    <div class="instruction-item">
                        <h4>📹 CAM Compounds</h4>
                        <p>Camera-focused layouts with microphone audio only. Perfect for talking head content, interviews, or vlogs.</p>
                    </div>
                    <div class="instruction-item">
                        <h4>🎮 GS (Game Share) Compounds</h4>
                        <p>Multi-view layouts showing camera, game, and screen with full audio mix. Ideal for gaming content with commentary.</p>
                    </div>
                    <div class="instruction-item">
                        <h4>🖥️ SSB (Screen Share Big) Compounds</h4>
                        <p>Large screen view with small camera overlay and screen audio only. Best for tutorials, presentations, or software demos.</p>
                    </div>
                </div>
                <div class="next-steps">
                    <h4>Next Steps:</h4>
                    <ol>
                        <li>Import the XML files you want into Final Cut Pro X</li>
                        <li>Each compound clip contains all your cuts ready to use</li>
                        <li>Switch between different layouts by using different compound clips</li>
                        <li>Double-click any compound to customize the internal layout</li>
                    </ol>
                </div>
            </div>
        `;
        
        resultsContainer.innerHTML = resultsHTML;
    } else {
        resultsContainer.innerHTML = `
            <div class="alert alert-warning">
                <div>⚠️</div>
                <div>No compound clips were generated. Check your audio source files and threshold settings.</div>
            </div>
        `;
    }
    
    // Scroll to results
    document.getElementById('resultsSection').scrollIntoView({ 
        behavior: 'smooth',
        block: 'start'
    });
    
    showAlert('success', `Processing completed! Generated ${job.results.length} compound clips.`);
}

// Show error
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

// Download file
function downloadFile(filePath) {
    const encodedPath = encodeURIComponent(filePath);
    const link = document.createElement('a');
    link.href = `/api/download/${encodedPath}`;
    link.download = filePath.split('/').pop(); // Get filename
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    showAlert('info', 'Download started!');
}

// Reset form
function resetForm() {
    document.getElementById('videoForm').reset();
    document.getElementById('progressSection').classList.add('hidden');
    document.getElementById('resultsSection').classList.add('hidden');
    
    // Clear project audio sources
    projectAudioSources = {};
    updateProjectAudioList();
    
    const processBtn = document.getElementById('processBtn');
    processBtn.disabled = false;
    processBtn.textContent = '🚀 Start Processing';
    
    currentJobId = null;
    
    if (progressTimer) {
        clearInterval(progressTimer);
        progressTimer = null;
    }
    
    // Clear alerts
    document.getElementById('alertsContainer').innerHTML = '';
    
    // Scroll to top
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
    
    console.log('loadFileBrowserPath called with:', path);
    fileList.innerHTML = '<div class="loading">Loading files...</div>';
    breadcrumb.textContent = path;
    
    const url = `/api/browse?path=${encodeURIComponent(path)}`;
    console.log('Making request to:', url);
    
    try {
        console.log('Fetching...');
        const response = await fetch(url);
        console.log('Response received:', response.status, response.statusText);
        
        const result = await response.json();
        console.log('JSON parsed:', result);
        
        if (result.success) {
            currentFileBrowserPath = result.currentPath;
            renderFileList(result.items);
        } else {
            console.error('API returned error:', result.error);
            fileList.innerHTML = `<div class="loading">Error: ${result.error}</div>`;
        }
    } catch (error) {
        console.error('Fetch error:', error);
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
        const isSelectable = item.type === 'video' || item.type === 'audio';
        
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
    // Clear previous selections
    document.querySelectorAll('.file-item').forEach(item => {
        item.classList.remove('selected');
    });
    
    if (type === 'directory') {
        // Navigate to directory
        loadFileBrowserPath(path);
    } else if (type === 'video') {
        // Select video file (master video browser only selects videos)
        selectedFilePath = path;
        event.target.closest('.file-item').classList.add('selected');
        document.getElementById('selectFileBtn').disabled = false;
    }
}

function selectCurrentFile() {
    if (!selectedFilePath) return;
    
    if (fileBrowserTarget === 'masterVideo') {
        document.getElementById('masterVideoPath').value = selectedFilePath;
    }
    
    closeFileBrowser();
}

function refreshAudioFiles() {
    autoDetectAudioFiles();
}