# Feature Additions - Auto-Detect, Master Projects, XML Accordion

## Features to Add:

1. ✅ Auto-detect audio files button
2. ✅ Master SOLO and Master DC checkboxes (unchecked by default)
3. ✅ XML options in accordion dropdown

---

## 1. Add Auto-Detect to IPC Handler

**File:** `electron/ipc/ipc-handlers.ts`

Add this function to `setupFileSystemHandlers()`:

```typescript
// Auto-detect audio files
ipcMain.handle('auto-detect-audio', async (event, masterPath: string) => {
  try {
    const fs = require('fs');
    const path = require('path');

    const directory = path.dirname(masterPath);
    const masterName = path.basename(masterPath, path.extname(masterPath));

    // Extract session from master filename
    const extractSession = (filename: string): string | null => {
      // Pattern 1: Date + Number (e.g., "2025-09-03 1")
      let match = filename.match(/^(\d{4}-\d{2}-\d{2}\s+\d+)/);
      if (match) return match[1];

      // Pattern 2: Date + Label (e.g., "2025-10-12 podcast")
      match = filename.match(/^(\d{4}-\d{2}-\d{2}\s+\w+)/);
      if (match) {
        let session = match[1];
        // Remove common suffixes
        session = session.replace(/\s+(master|mic|screen|game|audio|bluetooth|sound|effects|sfx).*/i, '').trim();
        return session;
      }

      return null;
    };

    const masterSession = extractSession(masterName);
    const audioFiles: { [key: string]: string } = {};
    const audioExts = ['.mp3', '.wav', '.aac', '.flac', '.ogg', '.m4a'];

    // Read directory
    const files = fs.readdirSync(directory);

    for (const file of files) {
      // Skip hidden/system files
      if (file.startsWith('._')) continue;

      const ext = path.extname(file).toLowerCase();
      if (!audioExts.includes(ext)) continue;

      const filePath = path.join(directory, file);
      const fileName = path.basename(file, ext);
      const fileNameLower = fileName.toLowerCase();

      // Extract session from this audio file
      const fileSession = extractSession(fileName);

      // Only match files from same session
      if (masterSession && fileSession && fileSession !== masterSession) {
        continue;
      }

      // Match audio file types based on naming patterns
      if (fileNameLower.includes('mic 1') || fileNameLower.includes('mic1') || fileNameLower.includes('mic audio 1')) {
        audioFiles['mic1'] = filePath;
      } else if (fileNameLower.includes('mic 2') || fileNameLower.includes('mic2') || fileNameLower.includes('mic audio 2')) {
        audioFiles['mic2'] = filePath;
      } else if (fileNameLower.includes('mic 3') || fileNameLower.includes('mic3') || fileNameLower.includes('mic audio 3')) {
        audioFiles['mic3'] = filePath;
      } else if (fileNameLower.includes('mic 4') || fileNameLower.includes('mic4') || fileNameLower.includes('mic audio 4')) {
        audioFiles['mic4'] = filePath;
      } else if ((fileNameLower.includes('mic audio') || fileNameLower.includes('mic')) &&
                 !['1', '2', '3', '4'].some(n => fileNameLower.includes(n))) {
        if (!audioFiles['mic1']) {
          audioFiles['mic1'] = filePath;
        }
      } else if (fileNameLower.includes('screen')) {
        audioFiles['screen'] = filePath;
      } else if (fileNameLower.includes('game')) {
        audioFiles['game'] = filePath;
      } else if (fileNameLower.includes('sound effects') || fileNameLower.includes('sfx') || fileNameLower.includes('soundeffects')) {
        audioFiles['soundEffects'] = filePath;
      } else if (fileNameLower.includes('bluetooth')) {
        audioFiles['bluetooth'] = filePath;
      }
    }

    return { success: true, audioFiles };
  } catch (error: any) {
    log.error('Error auto-detecting audio:', error);
    return { success: false, error: error.message };
  }
});
```

---

## 2. Add Auto-Detect to Preload

**File:** `electron/preload.ts`

Add to the `ElectronAPI` interface:

```typescript
export interface ElectronAPI {
  // ... existing methods ...
  autoDetectAudio: (masterPath: string) => Promise<any>;
}
```

Add to the `electronAPI` implementation:

```typescript
const electronAPI: ElectronAPI = {
  // ... existing methods ...
  autoDetectAudio: (masterPath) => ipcRenderer.invoke('auto-detect-audio', masterPath),
};
```

---

## 3. Add to Electron Service

**File:** `frontend/src/app/services/electron.service.ts`

Add method:

```typescript
async autoDetectAudio(masterPath: string): Promise<any> {
  if (!this.isElectron()) {
    throw new Error('Not running in Electron');
  }
  return window.electron.autoDetectAudio(masterPath);
}
```

---

## 4. Update Workflow Component TypeScript

**File:** `frontend/src/app/components/workflow/workflow.component.ts`

Add after the `xmlOptions` property:

```typescript
// XML accordion
xmlAccordionOpen = false;

// Master project options
masterSoloChecked = false;
masterDcChecked = false;
```

Add method for auto-detect:

```typescript
// Auto-detect audio files
async autoDetectAudioFiles() {
  if (!this.masterVideoPath) {
    alert('Please select a master video file first');
    return;
  }

  try {
    const result = await this.electronService.autoDetectAudio(this.masterVideoPath);

    if (result.success) {
      // Clear existing audio sources
      this.audioSources = [];

      // Add detected files
      Object.entries(result.audioFiles).forEach(([type, path]: [string, any]) => {
        const fileName = path.split('/').pop() || '';
        const audioSource: AudioSource = {
          id: `audio_${Date.now()}_${type}`,
          path,
          name: fileName,
          type: type === 'soundEffects' ? 'soundEffects' : type as AudioSourceType,
          syncFix: false,
          applyDrift: false
        };
        this.audioSources.push(audioSource);
      });

      alert(`Auto-detected ${this.audioSources.length} audio files`);
    } else {
      alert(`Could not auto-detect: ${result.error}`);
    }
  } catch (error) {
    console.error('Error auto-detecting:', error);
    alert('Error auto-detecting audio files: ' + error);
  }
}

// Toggle XML accordion
toggleXmlAccordion() {
  this.xmlAccordionOpen = !this.xmlAccordionOpen;
}

// Handle master project checkboxes
onMasterSoloChange() {
  if (this.masterSoloChecked) {
    // Check required options: camSolo, gsSolo, ssbSolo
    if (!this.selectedXmlOptions.includes('camSolo')) {
      this.selectedXmlOptions.push('camSolo');
    }
    if (!this.selectedXmlOptions.includes('gsSolo')) {
      this.selectedXmlOptions.push('gsSolo');
    }
    if (!this.selectedXmlOptions.includes('ssbSolo')) {
      this.selectedXmlOptions.push('ssbSolo');
    }
  } else {
    // Uncheck required options
    this.selectedXmlOptions = this.selectedXmlOptions.filter(opt =>
      !['camSolo', 'gsSolo', 'ssbSolo'].includes(opt)
    );
  }
}

onMasterDcChange() {
  if (this.masterDcChecked) {
    // Check required options: camDual, gsDual, ssbDual
    if (!this.selectedXmlOptions.includes('camDual')) {
      this.selectedXmlOptions.push('camDual');
    }
    if (!this.selectedXmlOptions.includes('gsDual')) {
      this.selectedXmlOptions.push('gsDual');
    }
    if (!this.selectedXmlOptions.includes('ssbDual')) {
      this.selectedXmlOptions.push('ssbDual');
    }
  } else {
    // Uncheck required options
    this.selectedXmlOptions = this.selectedXmlOptions.filter(opt =>
      !['camDual', 'gsDual', 'ssbDual'].includes(opt)
    );
  }
}
```

---

## 5. Update HTML Template

**File:** `frontend/src/app/components/workflow/workflow.component.html`

Replace the audio sources section button with:

```html
<div class="audio-source-actions">
  <button type="button" class="btn btn-secondary" (click)="autoDetectAudioFiles()">
    🔍 Auto-Detect Audio
  </button>
  <button type="button" class="btn btn-secondary" (click)="addAudioSource()">
    ➕ Add Audio File
  </button>
</div>
```

Replace the XML options section with:

```html
<!-- XML Options Accordion -->
<div class="form-group">
  <label>XML Generation Options</label>
  <small class="form-help">Select which compound clips to generate</small>

  <!-- Master Project Options (outside accordion) -->
  <div class="master-projects-section">
    <label class="checkbox-label">
      <input type="checkbox" [(ngModel)]="masterSoloChecked" (change)="onMasterSoloChange()" />
      <span class="checkbox-custom"></span>
      <div class="xml-option-info">
        <span class="xml-option-name">Master SOLO</span>
        <span class="xml-option-desc">Complete single camera project</span>
      </div>
    </label>

    <label class="checkbox-label">
      <input type="checkbox" [(ngModel)]="masterDcChecked" (change)="onMasterDcChange()" />
      <span class="checkbox-custom"></span>
      <div class="xml-option-info">
        <span class="xml-option-name">Master DC</span>
        <span class="xml-option-desc">Complete dual camera project</span>
      </div>
    </label>
  </div>

  <!-- XML Accordion -->
  <div class="xml-accordion">
    <div class="xml-accordion-header" (click)="toggleXmlAccordion()" [class.expanded]="xmlAccordionOpen">
      <h5 class="xml-section-title">Compound Clip Options</h5>
      <span class="accordion-icon">{{ xmlAccordionOpen ? '▲' : '▼' }}</span>
    </div>

    <div class="xml-accordion-content" [class.collapsed]="!xmlAccordionOpen">
      <div class="xml-options-actions mb-2">
        <button type="button" class="btn btn-small btn-secondary" (click)="selectAllXmlOptions()">All</button>
        <button type="button" class="btn btn-small btn-secondary" (click)="deselectAllXmlOptions()">None</button>
      </div>

      <div class="xml-options-container">
        <div *ngFor="let opt of xmlOptions" class="xml-option-item">
          <label class="checkbox-label">
            <input type="checkbox" [checked]="selectedXmlOptions.includes(opt.value)" (change)="toggleXmlOption(opt.value)" />
            <span class="checkbox-custom"></span>
            <div class="xml-option-info">
              <span class="xml-option-name">{{ opt.label }}</span>
              <span class="xml-option-desc">{{ opt.description }}</span>
            </div>
          </label>
        </div>
      </div>
    </div>
  </div>
</div>
```

---

## 6. Add CSS for Master Projects and Accordion

**File:** `frontend/src/styles.scss` (add at the end)

```scss
/* Master Projects Section */
.master-projects-section {
  background: linear-gradient(135deg, rgba(255, 107, 53, 0.1), rgba(255, 107, 53, 0.05));
  border: 2px solid var(--primary-orange);
  border-radius: var(--border-radius);
  padding: 1rem;
  margin: 1rem 0;
}

.master-projects-section .checkbox-label {
  padding: 0.75rem;
  margin-bottom: 0.75rem;
  background: var(--bg-card);
  border-radius: var(--border-radius);
  border: 1px solid var(--border-color);
  transition: var(--transition);
}

.master-projects-section .checkbox-label:last-child {
  margin-bottom: 0;
}

.master-projects-section .checkbox-label:hover {
  transform: translateX(4px);
  box-shadow: var(--shadow-sm);
}

/* XML Accordion */
.xml-accordion {
  margin-top: 1rem;
}

.xml-accordion-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
  padding: 1rem;
  background: var(--bg-secondary);
  border-radius: var(--border-radius);
  transition: var(--transition);
}

.xml-accordion-header:hover {
  background: var(--bg-tertiary);
}

.xml-accordion-header .xml-section-title {
  margin: 0;
  font-size: 1rem;
}

.accordion-icon {
  font-size: 0.9rem;
  color: var(--primary-orange);
  transition: transform 0.3s ease;
  font-weight: bold;
}

.xml-accordion-content {
  max-height: 1000px;
  overflow: hidden;
  transition: max-height 0.3s ease, opacity 0.3s ease, margin-top 0.3s ease;
  opacity: 1;
  margin-top: 1rem;
}

.xml-accordion-content.collapsed {
  max-height: 0;
  opacity: 0;
  margin-top: 0;
}
```

---

## 7. Update Types

**File:** `frontend/src/types/electron.d.ts`

Add to interface:

```typescript
export interface ElectronAPI {
  // ... existing methods ...
  autoDetectAudio: (masterPath: string) => Promise<any>;
}
```

---

## 8. Rebuild and Test

```bash
npm run build:all
npm run package:mac
```

Then test:
- ✅ Auto-detect button finds audio files
- ✅ Master SOLO/DC checkboxes work
- ✅ Clicking them checks/unchecks required compounds
- ✅ XML accordion opens/closes

---

This implements all 3 features exactly as you requested!
