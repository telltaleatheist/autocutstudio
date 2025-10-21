import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { ElectronService } from '../../services/electron.service';
import { ProcessingService } from '../../services/processing.service';
import { AudioSource, AudioSourceType, AUDIO_SOURCE_LABELS, XML_OPTIONS } from '../../models/types';

@Component({
  selector: 'app-workflow',
  standalone: false,
  templateUrl: './workflow.component.html',
  styleUrl: './workflow.component.scss'
})
export class WorkflowComponent implements OnInit {
  // Master video
  masterVideoPath = '';

  // Audio sources
  audioSources: AudioSource[] = [];
  audioSourceLabels = AUDIO_SOURCE_LABELS;
  audioTypes: AudioSourceType[] = ['mic1', 'mic2', 'mic3', 'mic4', 'screen', 'game', 'soundEffects', 'bluetooth'];

  // Video sources (optional)
  videoSources = {
    cam1: '',
    cam2: '',
    screen: '',
    game: ''
  };

  // Audio corrections
  globalDriftFrames = 0;

  // XML options
  xmlOptions = XML_OPTIONS;
  selectedXmlOptions: string[] = [];
  xmlAccordionOpen = false;

  // Master projects
  masterSolo = false;
  masterDc = false;

  // Processing
  isProcessing = false;
  consoleOutput: string[] = [];
  currentJobId = '';
  currentProgress = 0;
  currentMessage = '';

  // File browser
  showFileBrowser = false;
  fileBrowserMode: 'master' | 'audio' | 'videoSource' = 'master';
  fileBrowserTarget = '';

  constructor(
    private electronService: ElectronService,
    private processingService: ProcessingService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit() {
    // Subscribe to processing updates
    this.processingService.getCurrentJob().subscribe(job => {
      console.log('[WorkflowComponent] Received job update:', job);
      if (job) {
        this.isProcessing = job.status === 'running';
        this.consoleOutput = job.output;
        this.currentJobId = job.id;
        this.currentProgress = job.progress;
        this.currentMessage = job.message;
        console.log(`[WorkflowComponent] Updated: progress=${this.currentProgress}%, message=${this.currentMessage}, isProcessing=${this.isProcessing}`);
      } else {
        this.isProcessing = false;
        console.log('[WorkflowComponent] No active job');
      }
      // Force change detection for updates from outside Angular zone (Electron IPC)
      this.cdr.detectChanges();
    });
  }

  // Master video selection
  async selectMasterVideo() {
    try {
      const result = await this.electronService.selectFile({
        title: 'Select Master Video File',
        filters: [
          { name: 'Video Files', extensions: ['mp4', 'mov', 'avi', 'mkv', 'flv', 'wmv', 'mpg', 'mpeg', 'm4v', 'webm'] }
        ]
      });

      if (!result.canceled && result.filePaths.length > 0) {
        this.masterVideoPath = result.filePaths[0];
      }
    } catch (error) {
      console.error('Error selecting master video:', error);
      alert('Error selecting file: ' + error);
    }
  }

  // Audio source management
  async addAudioSource() {
    try {
      const result = await this.electronService.selectFile({
        title: 'Select Audio/Video File',
        filters: [
          { name: 'Audio Files', extensions: ['wav', 'mp3', 'aac', 'flac', 'ogg', 'm4a'] },
          { name: 'Video Files', extensions: ['mp4', 'mov', 'avi', 'mkv'] }
        ]
      });

      if (!result.canceled && result.filePaths.length > 0) {
        const path = result.filePaths[0];
        const fileName = path.split('/').pop() || '';

        const audioSource: AudioSource = {
          id: `audio_${Date.now()}`,
          path,
          name: fileName,
          type: '',
          syncFix: false,
          applyDrift: false
        };

        this.audioSources.push(audioSource);
      }
    } catch (error) {
      console.error('Error adding audio source:', error);
      alert('Error selecting file: ' + error);
    }
  }

  removeAudioSource(id: string) {
    this.audioSources = this.audioSources.filter(s => s.id !== id);
  }

  // Auto-detect audio files
  async autoDetectAudioFiles() {
    if (!this.masterVideoPath) {
      return;
    }

    try {
      const result = await this.electronService.autoDetectAudio(this.masterVideoPath);

      if (result.success && result.audioFiles) {
        const audioFiles = result.audioFiles;
        const audioTypeMap: { [key: string]: AudioSourceType } = {
          'mic-1': 'mic1',
          'mic-2': 'mic2',
          'mic-3': 'mic3',
          'mic-4': 'mic4',
          'screen': 'screen',
          'game': 'game',
          'sound-effects': 'soundEffects',
          'bluetooth': 'bluetooth'
        };

        // Clear existing audio sources
        this.audioSources = [];

        // Add detected audio files
        for (const [audioType, audioPath] of Object.entries(audioFiles)) {
          const fileName = audioPath.split('/').pop() || '';
          const mappedType = audioTypeMap[audioType];

          if (mappedType) {
            const audioSource: AudioSource = {
              id: `audio_${Date.now()}_${audioType}`,
              path: audioPath,
              name: fileName,
              type: mappedType,
              syncFix: false,
              applyDrift: false
            };

            this.audioSources.push(audioSource);
          }
        }
      }
    } catch (error) {
      console.error('Error auto-detecting audio:', error);
    }
  }

  getAvailableAudioTypes(currentType: string): AudioSourceType[] {
    const usedTypes = this.audioSources
      .filter(s => s.type && s.type !== currentType)
      .map(s => s.type as AudioSourceType);
    return this.audioTypes.filter(type => !usedTypes.includes(type));
  }

  // Video source selection
  async selectVideoSource(sourceType: 'cam1' | 'cam2' | 'screen' | 'game') {
    try {
      const result = await this.electronService.selectFile({
        title: `Select ${sourceType} Video`,
        filters: [
          { name: 'Video Files', extensions: ['mp4', 'mov', 'avi', 'mkv'] }
        ]
      });

      if (!result.canceled && result.filePaths.length > 0) {
        this.videoSources[sourceType] = result.filePaths[0];
      }
    } catch (error) {
      console.error('Error selecting video source:', error);
      alert('Error selecting file: ' + error);
    }
  }

  clearVideoSource(sourceType: 'cam1' | 'cam2' | 'screen' | 'game') {
    this.videoSources[sourceType] = '';
  }

  // XML options
  toggleXmlOption(value: string) {
    const index = this.selectedXmlOptions.indexOf(value);
    if (index > -1) {
      this.selectedXmlOptions.splice(index, 1);
    } else {
      this.selectedXmlOptions.push(value);
    }
  }

  selectAllXmlOptions() {
    this.selectedXmlOptions = this.xmlOptions.map(opt => opt.value);
  }

  deselectAllXmlOptions() {
    this.selectedXmlOptions = [];
  }

  toggleXmlAccordion() {
    this.xmlAccordionOpen = !this.xmlAccordionOpen;
  }

  // Master project handlers
  onMasterSoloChange(checked: boolean) {
    this.masterSolo = checked;

    // Auto-select required XML options
    const soloOptions = ['camSolo', 'gsSolo', 'ssbSolo'];

    if (checked) {
      // Add SOLO options if not already selected
      soloOptions.forEach(opt => {
        if (!this.selectedXmlOptions.includes(opt)) {
          this.selectedXmlOptions.push(opt);
        }
      });
    } else {
      // Remove SOLO options
      this.selectedXmlOptions = this.selectedXmlOptions.filter(opt => !soloOptions.includes(opt));
    }
  }

  onMasterDcChange(checked: boolean) {
    this.masterDc = checked;

    // Auto-select required XML options
    const dcOptions = ['camDual', 'gsDual', 'ssbDual'];

    if (checked) {
      // Add DC options if not already selected
      dcOptions.forEach(opt => {
        if (!this.selectedXmlOptions.includes(opt)) {
          this.selectedXmlOptions.push(opt);
        }
      });
    } else {
      // Remove DC options
      this.selectedXmlOptions = this.selectedXmlOptions.filter(opt => !dcOptions.includes(opt));
    }
  }

  // Process workflow
  async processWorkflow() {
    console.log('Process button clicked!');

    // Validation - just return silently, button is disabled when invalid
    if (!this.masterVideoPath || this.audioSources.length === 0) {
      console.log('Validation failed: missing master video or audio sources');
      alert('Please select a master video and add at least one audio source.');
      return;
    }

    // Check if all audio sources have types assigned
    const unassignedAudio = this.audioSources.filter(s => !s.type);
    if (unassignedAudio.length > 0) {
      console.log('Validation failed: unassigned audio sources', unassignedAudio);
      alert('Please assign types to all audio sources.');
      return;
    }

    try {
      console.log('Building workflow options...');

      // Build audio sources object
      const audioSourcesObj: { [key: string]: string } = {};
      const audioSyncSettings: { [key: string]: boolean } = {};

      this.audioSources.forEach(source => {
        if (source.type) {
          audioSourcesObj[source.type] = source.path;
          audioSyncSettings[source.type] = source.syncFix || source.applyDrift;
        }
      });

      // Add master project options to xmlOptions if checked
      const xmlOptionsToSend = [...this.selectedXmlOptions];
      if (this.masterSolo && !xmlOptionsToSend.includes('masterSolo')) {
        xmlOptionsToSend.push('masterSolo');
      }
      if (this.masterDc && !xmlOptionsToSend.includes('masterDc')) {
        xmlOptionsToSend.push('masterDc');
      }

      // Build options
      const options = {
        masterVideo: this.masterVideoPath,
        audioSources: audioSourcesObj,
        audioSyncSettings,
        videoSources: this.videoSources,
        xmlOptions: xmlOptionsToSend.length > 0 ? xmlOptionsToSend : undefined
      };

      console.log('Workflow options:', options);
      console.log('Starting workflow...');

      // Start workflow
      await this.processingService.startWorkflow(options);

      console.log('Workflow started successfully!');
    } catch (error) {
      console.error('Error starting workflow:', error);
      alert('Error starting workflow: ' + error);
    }
  }

  // Cancel job
  async cancelJob() {
    if (confirm('Are you sure you want to cancel the current job?')) {
      await this.processingService.cancelJob();
    }
  }
}
