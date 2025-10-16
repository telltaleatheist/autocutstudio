// webui/static/js/app.js

// Global variables
let currentJobId = null;
let progressTimer = null;
let currentFileBrowserPath = '/Volumes/Callisto/Movies';
let selectedFilePath = null;
let fileBrowserTarget = null;
let projectAudioSources = {};
let projectVideoSources = {};  // Store optional video sources
let browserMode = 'master';
let masterVideoDuration = null;
let audioChangesInProgress = false;

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

// Accordion toggle function
function toggleAccordion(accordionId) {
    const content = document.getElementById(accordionId);
    const header = content.previousElementSibling;

    if (content.classList.contains('collapsed')) {
        content.classList.remove('collapsed');
        header.classList.add('expanded');
    } else {
        content.classList.add('collapsed');
        header.classList.remove('expanded');
    }
}

// Master project dependency management
function handleMasterProjectChange(masterType) {
    const masterCheckbox = document.querySelector(`input[value="${masterType}"]`);

    if (masterCheckbox.checked) {
        // If master project is checked, check required compounds
        if (masterType === 'masterSolo') {
            // SOLO Master requires: camSolo, gsSolo, ssbSolo
            document.querySelector('input[value="camSolo"]').checked = true;
            document.querySelector('input[value="gsSolo"]').checked = true;
            document.querySelector('input[value="ssbSolo"]').checked = true;
        } else if (masterType === 'masterDC') {
            // DC Master requires: camDual, gsDual, ssbDual
            document.querySelector('input[value="camDual"]').checked = true;
            document.querySelector('input[value="gsDual"]').checked = true;
            document.querySelector('input[value="ssbDual"]').checked = true;
        }
    } else {
        // If master project is unchecked, uncheck required compounds
        if (masterType === 'masterSolo') {
            document.querySelector('input[value="camSolo"]').checked = false;
            document.querySelector('input[value="gsSolo"]').checked = false;
            document.querySelector('input[value="ssbSolo"]').checked = false;
        } else if (masterType === 'masterDC') {
            document.querySelector('input[value="camDual"]').checked = false;
            document.querySelector('input[value="gsDual"]').checked = false;
            document.querySelector('input[value="ssbDual"]').checked = false;
        }
    }
}

// Video source management
function openVideoSourceBrowser(sourceType) {
    fileBrowserTarget = sourceType;
    browserMode = 'videoSource';
    selectedFilePath = null;

    const labels = {
        'cam1': 'Camera 1 Video',
        'cam2': 'Camera 2 Video',
        'screen': 'Screen Video',
        'game': 'Game Video'
    };

    document.getElementById('modalTitle').textContent = `📁 Select ${labels[sourceType]}`;
    document.getElementById('fileBrowserModal').classList.remove('hidden');
    document.getElementById('selectFileBtn').classList.remove('hidden');
    document.getElementById('selectFileBtn').disabled = true;
    document.getElementById('selectFileBtn').textContent = 'Select Video';
    loadFileBrowserPath(currentFileBrowserPath);
}

function clearVideoSource(sourceType) {
    const pathInputId = `${sourceType}VideoPath`;
    const clearBtnId = `clear${sourceType.charAt(0).toUpperCase() + sourceType.slice(1)}Btn`;

    document.getElementById(pathInputId).value = '';
    document.getElementById(clearBtnId).style.display = 'none';

    delete projectVideoSources[sourceType];
}

function setVideoSource(sourceType, path) {
    const pathInputId = `${sourceType}VideoPath`;
    const clearBtnId = `clear${sourceType.charAt(0).toUpperCase() + sourceType.slice(1)}Btn`;

    document.getElementById(pathInputId).value = path;
    document.getElementById(clearBtnId).style.display = 'inline-flex';

    projectVideoSources[sourceType] = path;
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
        updateCorrectionsStatus();
        return;
    }
    
    let html = '';
    for (const [id, source] of Object.entries(projectAudioSources)) {
        const fileName = source.path.split('/').pop();
        const syncCheckboxId = `sync${id}`;
        const driftCheckboxId = `drift${id}`;
        const applyCorrectionsId = `apply${id}`;
        
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
        
        // Check if file has been corrected
        const hasCorrectionsSuffix = fileName.includes('_synced') || fileName.includes('_drift_');
        
        html += `
            <div class="project-audio-item ${!source.type ? 'unassigned' : ''}" data-id="${id}">
                <div class="audio-item-info">
                    <div class="audio-item-path" title="${source.path}">${fileName}</div>
                    ${hasCorrectionsSuffix ? '<span class="audio-corrected-badge">Corrected</span>' : ''}
                </div>
                <div class="audio-item-controls">
                    <select class="audio-type-select" onchange="assignAudioType('${id}', this.value)">
                        ${audioTypes.map(opt => {
                            const disabled = (opt.value && usedTypes.includes(opt.value)) ? 'disabled' : '';
                            const selected = source.type === opt.value ? 'selected' : '';
                            return `<option value="${opt.value}" ${disabled} ${selected}>${opt.label}${disabled ? ' (in use)' : ''}</option>`;
                        }).join('')}
                    </select>
                    
                    <div class="audio-corrections-group">
                        <label class="checkbox-label" title="29.97fps sync correction">
                            <input type="checkbox" id="${syncCheckboxId}"
                                   onchange="updateAudioSyncSetting('${id}', this.checked)"
                                   ${source.syncFix ? 'checked' : ''}
                                   ${!source.type ? 'disabled' : ''}>
                            <span class="checkbox-custom"></span>
                            29.97
                        </label>

                        <label class="checkbox-label" title="Apply drift correction">
                            <input type="checkbox" id="${driftCheckboxId}"
                                   onchange="updateAudioDriftSetting('${id}', this.checked)"
                                   ${source.applyDrift ? 'checked' : ''}
                                   ${!source.type ? 'disabled' : ''}>
                            <span class="checkbox-custom"></span>
                            Drift
                        </label>
                    </div>
                    
                    <button type="button" class="btn btn-small btn-danger" onclick="removeAudioSource('${id}')">
                        Remove
                    </button>
                </div>
            </div>
        `;
    }
    
    container.innerHTML = html;
    updateCorrectionsStatus();
}

function updateApplyCorrections(fileId, apply) {
    if (projectAudioSources[fileId]) {
        projectAudioSources[fileId].applyCorrections = apply;
        
        // Enable/disable the sync and drift checkboxes
        const syncCheckbox = document.getElementById(`sync${fileId}`);
        const driftCheckbox = document.getElementById(`drift${fileId}`);
        
        if (syncCheckbox) syncCheckbox.disabled = !apply;
        if (driftCheckbox) driftCheckbox.disabled = !apply;
        
        // Reset if disabled
        if (!apply) {
            projectAudioSources[fileId].syncFix = false;
            projectAudioSources[fileId].applyDrift = false;
            if (syncCheckbox) syncCheckbox.checked = false;
            if (driftCheckbox) driftCheckbox.checked = false;
        }
        
        updateCorrectionsStatus();
    }
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
        updateCorrectionsStatus();
    }
}

function updateGlobalDrift() {
    const driftInput = document.getElementById('globalDriftFrames');
    globalDriftFrames = parseFloat(driftInput.value) || 0;
    
    // Update drift info display
    if (globalDriftFrames && masterVideoDuration) {
        const fps = 29.97;
        const totalFrames = masterVideoDuration * fps;
        const correctionFactor = 1 + (globalDriftFrames / totalFrames);
        
        document.getElementById('driftCorrectionInfo').textContent = 
            `Correction: ${correctionFactor.toFixed(6)}x`;
    } else {
        document.getElementById('driftCorrectionInfo').textContent = '';
    }
    
    updateCorrectionsStatus();
}

function updateCorrectionsStatus() {
    const statusEl = document.getElementById('correctionsStatus');
    const applyBtn = document.getElementById('applyCorrectionsBtn');

    // Count files marked for corrections (either syncFix OR applyDrift)
    const filesForCorrection = Object.values(projectAudioSources)
        .filter(s => s.type && (s.syncFix || s.applyDrift));

    const syncCount = filesForCorrection.filter(s => s.syncFix).length;
    const driftCount = filesForCorrection.filter(s => s.applyDrift).length;

    if (filesForCorrection.length === 0) {
        statusEl.textContent = 'Check "29.97" or "Drift" on files to enable';
        applyBtn.disabled = true;
    } else {
        let status = `Ready to process ${filesForCorrection.length} file(s)`;
        const corrections = [];
        if (syncCount > 0) corrections.push(`${syncCount} with 29.97 sync`);
        if (driftCount > 0) corrections.push(`${driftCount} with drift correction`);
        if (corrections.length > 0) {
            status += ` (${corrections.join(', ')})`;
        }
        statusEl.textContent = status;
        applyBtn.disabled = false;
    }
}

async function applyAudioCorrections() {
    // Get files marked for correction (either syncFix OR applyDrift)
    const filesToProcess = [];

    for (const [id, source] of Object.entries(projectAudioSources)) {
        if (source.type && (source.syncFix || source.applyDrift)) {
            filesToProcess.push({
                id: id,
                path: source.path,
                type: source.type,
                syncFix: source.syncFix || false,
                applyDrift: source.applyDrift || false,
                driftFrames: source.applyDrift ? globalDriftFrames : 0
            });
        }
    }
    
    if (filesToProcess.length === 0) {
        showAlert('warning', 'No files selected for correction');
        return;
    }
    
    // Validate drift correction if any files need it
    const needsDrift = filesToProcess.some(f => f.applyDrift);
    if (needsDrift && !globalDriftFrames) {
        showAlert('warning', 'Please enter drift frames value');
        return;
    }
    
    if (needsDrift && !masterVideoDuration) {
        await fetchMasterVideoDuration();
        if (!masterVideoDuration) {
            showAlert('warning', 'Please select master video to calculate drift correction');
            return;
        }
    }
    
    const applyBtn = document.getElementById('applyCorrectionsBtn');
    applyBtn.disabled = true;
    applyBtn.textContent = 'Processing...';
    
    try {
        const response = await fetch('/api/apply-audio-corrections', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                files: filesToProcess,
                globalDriftFrames: globalDriftFrames,
                videoDuration: masterVideoDuration
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            showAlert('success', `Successfully processed ${result.processedFiles.length} audio files`);
            
            // Update paths to corrected versions
            result.processedFiles.forEach(file => {
                if (projectAudioSources[file.id]) {
                    projectAudioSources[file.id].path = file.newPath;
                    // Reset correction flags since file is now corrected
                    projectAudioSources[file.id].syncFix = false;
                    projectAudioSources[file.id].applyDrift = false;
                }
            });
            
            updateProjectAudioList();
        } else {
            showAlert('danger', `Failed to process audio: ${result.error}`);
        }
    } catch (error) {
        showAlert('danger', `Error processing audio: ${error.message}`);
    } finally {
        applyBtn.disabled = false;
        applyBtn.textContent = '🎵 Apply Audio Corrections';
    }
}

async function fetchMasterVideoDuration() {
    const masterPath = document.getElementById('masterVideoPath').value;
    if (!masterPath) return;
    
    try {
        const response = await fetch('/api/video-duration', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videoPath: masterPath })
        });
        
        const result = await response.json();
        if (result.success) {
            masterVideoDuration = result.duration;
        }
    } catch (error) {
        console.error('Error fetching video duration:', error);
    }
}

function updateAudioDriftSetting(fileId, driftEnabled) {
    if (projectAudioSources[fileId]) {
        projectAudioSources[fileId].applyDrift = driftEnabled;
        updateCorrectionsStatus();
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
        videoSources: projectVideoSources,  // Add optional video sources
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
                           (browserMode === 'audio' && (item.type === 'audio' || item.type === 'video')) ||
                           (browserMode === 'videoSource' && item.type === 'video');

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
               (browserMode === 'audio' && (type === 'audio' || type === 'video')) ||
               (browserMode === 'videoSource' && type === 'video')) {
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
    } else if (browserMode === 'videoSource') {
        // Handle video source selection (cam1, screen, game)
        setVideoSource(fileBrowserTarget, selectedFilePath);
        closeFileBrowser();

        const labels = {
            'cam1': 'Camera 1',
            'cam2': 'Camera 2',
            'screen': 'Screen',
            'game': 'Game'
        };
        showAlert('success', `Added ${labels[fileBrowserTarget]} video source`);
    }
}

function updateProjectAudioListExtended() {
    // Call original function
    updateProjectAudioList();
    
    // Also update audio changes file list
    updateAudioChangeFiles();
}

// Replace all calls to updateProjectAudioList with updateProjectAudioListExtended

function updateAudioChangeFiles() {
    const container = document.getElementById('audioChangeFiles');
    
    if (Object.keys(projectAudioSources).length === 0) {
        container.innerHTML = '<p class="form-help">Add audio files to the project first</p>';
        document.getElementById('applyChangesBtn').disabled = true;
        return;
    }
    
    let html = '';
    let hasAssignedFiles = false;
    
    for (const [id, source] of Object.entries(projectAudioSources)) {
        if (source.type) {  // Only show assigned files
            hasAssignedFiles = true;
            const fileName = source.path.split('/').pop();
            const checkboxId = `audioChange_${id}`;
            
            html += `
                <div class="audio-change-file-item">
                    <label class="checkbox-label audio-change-checkbox">
                        <input type="checkbox" id="${checkboxId}" value="${id}" name="audioChangeFiles">
                        <span class="checkbox-custom"></span>
                    </label>
                    <span class="audio-change-filename" title="${source.path}">${fileName}</span>
                    <span class="audio-change-type">${getAudioTypeLabel(source.type)}</span>
                </div>
            `;
        }
    }
    
    if (!hasAssignedFiles) {
        html = '<p class="form-help">Assign types to audio files first</p>';
        document.getElementById('applyChangesBtn').disabled = true;
    } else {
        document.getElementById('applyChangesBtn').disabled = false;
    }
    
    container.innerHTML = html;
}

// Calculate drift correction when master video is selected or drift frames change
function calculateDriftCorrection() {
    const masterPath = document.getElementById('masterVideoPath').value;
    const driftFrames = parseFloat(document.getElementById('driftFrames').value);
    
    if (!masterPath || !driftFrames) {
        document.getElementById('driftInfo').classList.add('hidden');
        return;
    }
    
    // Get video duration from backend
    fetchVideoDuration(masterPath).then(duration => {
        if (duration) {
            masterVideoDuration = duration;
            const fps = 29.97;
            const totalFrames = duration * fps;
            const correctionFactor = 1 + (driftFrames / totalFrames);
            
            // Update UI
            document.getElementById('videoDuration').textContent = formatDuration(duration);
            document.getElementById('correctionFactor').textContent = correctionFactor.toFixed(6);
            document.getElementById('driftInfo').classList.remove('hidden');
        }
    });
}

async function fetchVideoDuration(videoPath) {
    try {
        const response = await fetch('/api/video-duration', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videoPath: videoPath })
        });
        
        const result = await response.json();
        if (result.success) {
            return result.duration;
        }
    } catch (error) {
        console.error('Error fetching video duration:', error);
    }
    return null;
}

function formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

async function applyAudioChanges() {
    // Get selected files
    const selectedFiles = [];
    document.querySelectorAll('input[name="audioChangeFiles"]:checked').forEach(checkbox => {
        const fileId = checkbox.value;
        if (projectAudioSources[fileId]) {
            selectedFiles.push({
                id: fileId,
                path: projectAudioSources[fileId].path,
                type: projectAudioSources[fileId].type
            });
        }
    });
    
    if (selectedFiles.length === 0) {
        showAlert('warning', 'Please select at least one audio file to process');
        return;
    }
    
    const driftFrames = parseFloat(document.getElementById('driftFrames').value);
    if (!driftFrames) {
        showAlert('warning', 'Please enter the number of frames to correct');
        return;
    }
    
    if (!masterVideoDuration) {
        showAlert('warning', 'Please select a master video first to calculate correction');
        return;
    }
    
    // Calculate correction factor
    const fps = 29.97;
    const totalFrames = masterVideoDuration * fps;
    const correctionFactor = 1 + (driftFrames / totalFrames);
    
    // Disable button during processing
    const applyBtn = document.getElementById('applyChangesBtn');
    applyBtn.disabled = true;
    applyBtn.textContent = 'Processing...';
    audioChangesInProgress = true;
    
    try {
        const response = await fetch('/api/apply-audio-changes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                files: selectedFiles,
                driftFrames: driftFrames,
                videoDuration: masterVideoDuration,
                correctionFactor: correctionFactor
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            showAlert('success', `Successfully processed ${result.processedFiles.length} audio files`);
            
            // Update project audio sources with new files
            result.processedFiles.forEach(file => {
                // Update the path to the corrected version
                if (projectAudioSources[file.id]) {
                    projectAudioSources[file.id].path = file.newPath;
                }
            });
            
            updateProjectAudioListExtended();
        } else {
            showAlert('danger', `Failed to process audio: ${result.error}`);
        }
    } catch (error) {
        showAlert('danger', `Error processing audio: ${error.message}`);
    } finally {
        applyBtn.disabled = false;
        applyBtn.textContent = '🎵 Apply Audio Changes';
        audioChangesInProgress = false;
    }
}

document.addEventListener('DOMContentLoaded', function() {
    const masterVideoPath = document.getElementById('masterVideoPath');
    if (masterVideoPath) {
        const observer = new MutationObserver(function(mutations) {
            fetchMasterVideoDuration();
        });
        
        observer.observe(masterVideoPath, {
            attributes: true,
            attributeFilter: ['value']
        });
    }
});

// Event listeners for drift calculation
document.addEventListener('DOMContentLoaded', function() {
    // Add event listener for drift frames input
    const driftFramesInput = document.getElementById('driftFrames');
    if (driftFramesInput) {
        driftFramesInput.addEventListener('input', calculateDriftCorrection);
    }

    // Watch for master video changes
    const masterVideoPath = document.getElementById('masterVideoPath');
    if (masterVideoPath) {
        // Create a MutationObserver to watch for value changes
        const observer = new MutationObserver(function(mutations) {
            calculateDriftCorrection();
        });

        observer.observe(masterVideoPath, {
            attributes: true,
            attributeFilter: ['value']
        });

        // Also add direct event listener for programmatic changes
        masterVideoPath.addEventListener('change', calculateDriftCorrection);
    }

    // Add change listeners to master project checkboxes
    const masterSoloCheckbox = document.querySelector('input[value="masterSolo"]');
    const masterDCCheckbox = document.querySelector('input[value="masterDC"]');

    if (masterSoloCheckbox) {
        masterSoloCheckbox.addEventListener('change', function() {
            handleMasterProjectChange('masterSolo');
        });
    }

    if (masterDCCheckbox) {
        masterDCCheckbox.addEventListener('change', function() {
            handleMasterProjectChange('masterDC');
        });
    }
});