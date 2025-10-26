import { Component } from '@angular/core';
import { ElectronService } from '../../services/electron.service';

interface AudioFile {
  id: string;
  path: string;
  name: string;
  outputPath: string;
  processing: boolean;
  completed: boolean;
  error?: string;
}

@Component({
  selector: 'app-audio-editor',
  standalone: false,
  templateUrl: './audio-editor.component.html',
  styleUrl: './audio-editor.component.scss'
})
export class AudioEditorComponent {
  audioFiles: AudioFile[] = [];
  globalDriftFrames: number = 0;

  constructor(private electronService: ElectronService) {}

  /**
   * Add audio files to the list (supports multiple selection)
   */
  async addAudioFile() {
    try {
      const result = await this.electronService.selectFile({
        title: 'Select Audio Files',
        filters: [
          { name: 'Audio Files', extensions: ['wav', 'mp3', 'aac', 'flac', 'ogg', 'm4a'] }
        ],
        properties: ['openFile', 'multiSelections']
      });

      if (!result.canceled && result.filePaths.length > 0) {
        // Add all selected files
        for (const path of result.filePaths) {
          const fileName = path.split('/').pop() || '';

          const audioFile: AudioFile = {
            id: `audio_${Date.now()}_${Math.random()}`,
            path,
            name: fileName,
            outputPath: '',
            processing: false,
            completed: false
          };

          this.audioFiles.push(audioFile);
        }
      }
    } catch (error) {
      console.error('Error adding audio file:', error);
      alert('Error selecting file: ' + error);
    }
  }

  /**
   * Remove an audio file from the list
   */
  removeAudioFile(id: string) {
    this.audioFiles = this.audioFiles.filter(f => f.id !== id);
  }

  /**
   * Apply drift correction to a single audio file using global drift value
   */
  async applyDriftCorrection(audioFile: AudioFile) {
    if (!audioFile.path) {
      alert('No audio file selected');
      return;
    }

    if (this.globalDriftFrames === 0) {
      alert('Drift frames must be non-zero to apply correction');
      return;
    }

    try {
      audioFile.processing = true;
      audioFile.error = undefined;

      const result = await this.electronService.applyAudioDrift({
        inputPath: audioFile.path,
        driftFrames: this.globalDriftFrames
      });

      if (result.success && result.outputPath) {
        audioFile.outputPath = result.outputPath;
        audioFile.completed = true;
        console.log('Drift correction applied:', result.outputPath);
      } else {
        audioFile.error = result.error || 'Failed to apply drift correction';
        console.error('Error applying drift correction:', result.error);
      }
    } catch (error: any) {
      audioFile.error = error.message || 'Unknown error occurred';
      console.error('Error applying drift correction:', error);
    } finally {
      audioFile.processing = false;
    }
  }

  /**
   * Apply drift correction to all audio files using global drift value
   */
  async applyDriftCorrectionToAll() {
    if (this.globalDriftFrames === 0) {
      alert('Drift frames must be non-zero to apply correction. Please adjust the slider.');
      return;
    }

    const filesToProcess = this.audioFiles.filter(f => !f.completed);

    if (filesToProcess.length === 0) {
      alert('No files to process. All files have already been processed.');
      return;
    }

    for (const file of filesToProcess) {
      await this.applyDriftCorrection(file);
    }
  }

  /**
   * Show output file in folder
   */
  async showInFolder(audioFile: AudioFile) {
    if (!audioFile.outputPath) {
      alert('No output file available');
      return;
    }

    try {
      await this.electronService.showInFolder(audioFile.outputPath);
    } catch (error) {
      console.error('Error showing file in folder:', error);
      alert('Error showing file: ' + error);
    }
  }

  /**
   * Get drift display in seconds + frames format
   */
  getDriftDisplay(): string {
    if (this.globalDriftFrames === 0) {
      return '0s 0f';
    }

    const totalSeconds = Math.abs(this.globalDriftFrames);
    const seconds = Math.floor(totalSeconds);
    const frames = Math.round((totalSeconds - seconds) * 30);
    const sign = this.globalDriftFrames < 0 ? '-' : '+';

    return `${sign}${seconds}s ${frames}f`;
  }

  /**
   * Get speed change description
   */
  getSpeedDescription(): string {
    if (this.globalDriftFrames === 0) {
      return '→ No change';
    }

    const totalSeconds = Math.abs(this.globalDriftFrames);
    const seconds = Math.floor(totalSeconds);
    const frames = Math.round((totalSeconds - seconds) * 30);

    if (this.globalDriftFrames > 0) {
      return `→ Stretch by ${seconds}s ${frames}f`;
    } else {
      return `→ Shrink by ${seconds}s ${frames}f`;
    }
  }
}
