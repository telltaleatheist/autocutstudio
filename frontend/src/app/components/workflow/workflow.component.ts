import { Component, OnInit } from '@angular/core';
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

  // Processing
  isProcessing = false;
  showConsole = false;
  consoleOutput: string[] = [];
  currentJobId = '';

  // File browser
  showFileBrowser = false;
  fileBrowserMode: 'master' | 'audio' | 'videoSource' = 'master';
  fileBrowserTarget = '';

  constructor(
    private electronService: ElectronService,
    private processingService: ProcessingService
  ) {}

  ngOnInit() {
    // Subscribe to processing updates
    this.processingService.getCurrentJob().subscribe(job => {
      if (job) {
        this.isProcessing = job.status === 'running';
        this.consoleOutput = job.output;
        this.currentJobId = job.id;

        // Auto-open console when job starts
        if (job.status === 'running' && !this.showConsole) {
          this.showConsole = true;
        }
      } else {
        this.isProcessing = false;
      }
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

  // Process workflow
  async processWorkflow() {
    // Validation
    if (!this.masterVideoPath) {
      alert('Please select a master video file');
      return;
    }

    if (this.audioSources.length === 0) {
      alert('Please add at least one audio source');
      return;
    }

    // Check if all audio sources have types assigned
    const unassignedAudio = this.audioSources.filter(s => !s.type);
    if (unassignedAudio.length > 0) {
      alert('Please assign types to all audio sources');
      return;
    }

    try {
      // Build audio sources object
      const audioSourcesObj: { [key: string]: string } = {};
      const audioSyncSettings: { [key: string]: boolean } = {};

      this.audioSources.forEach(source => {
        if (source.type) {
          audioSourcesObj[source.type] = source.path;
          audioSyncSettings[source.type] = source.syncFix || source.applyDrift;
        }
      });

      // Build options
      const options = {
        masterVideo: this.masterVideoPath,
        audioSources: audioSourcesObj,
        audioSyncSettings,
        videoSources: this.videoSources,
        xmlOptions: this.selectedXmlOptions.length > 0 ? this.selectedXmlOptions : undefined
      };

      // Start workflow
      await this.processingService.startWorkflow(options);
      this.showConsole = true;
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

  // Console control
  closeConsole() {
    this.showConsole = false;
  }
}
