import { Component } from '@angular/core';
import { ElectronService } from '../../services/electron.service';

interface AudioFile {
  id: string;
  path: string;
  name: string;
  driftFrames: number;
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

  constructor(private electronService: ElectronService) {}

  /**
   * Add an audio file to the list
   */
  async addAudioFile() {
    try {
      const result = await this.electronService.selectFile({
        title: 'Select Audio File',
        filters: [
          { name: 'Audio Files', extensions: ['wav', 'mp3', 'aac', 'flac', 'ogg', 'm4a'] }
        ]
      });

      if (!result.canceled && result.filePaths.length > 0) {
        const path = result.filePaths[0];
        const fileName = path.split('/').pop() || '';

        const audioFile: AudioFile = {
          id: `audio_${Date.now()}`,
          path,
          name: fileName,
          driftFrames: 0,
          outputPath: '',
          processing: false,
          completed: false
        };

        this.audioFiles.push(audioFile);
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
   * Apply drift correction to a single audio file
   */
  async applyDriftCorrection(audioFile: AudioFile) {
    if (!audioFile.path) {
      alert('No audio file selected');
      return;
    }

    if (audioFile.driftFrames === 0) {
      alert('Drift frames must be non-zero to apply correction');
      return;
    }

    try {
      audioFile.processing = true;
      audioFile.error = undefined;

      const result = await this.electronService.applyAudioDrift({
        inputPath: audioFile.path,
        driftFrames: audioFile.driftFrames
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
   * Apply drift correction to all audio files
   */
  async applyDriftCorrectionToAll() {
    const filesToProcess = this.audioFiles.filter(f => !f.completed && f.driftFrames !== 0);

    if (filesToProcess.length === 0) {
      alert('No files to process. Make sure you have files with non-zero drift frames.');
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
  getDriftDisplay(audioFile: AudioFile): string {
    if (audioFile.driftFrames === 0) {
      return '0s 0f';
    }

    const totalSeconds = Math.abs(audioFile.driftFrames);
    const seconds = Math.floor(totalSeconds);
    const frames = Math.round((totalSeconds - seconds) * 30);
    const sign = audioFile.driftFrames < 0 ? '-' : '+';

    return `${sign}${seconds}s ${frames}f`;
  }

  /**
   * Get speed change description
   */
  getSpeedDescription(audioFile: AudioFile): string {
    if (audioFile.driftFrames === 0) {
      return '→ No change';
    }

    const totalSeconds = Math.abs(audioFile.driftFrames);
    const seconds = Math.floor(totalSeconds);
    const frames = Math.round((totalSeconds - seconds) * 30);

    if (audioFile.driftFrames > 0) {
      return `→ Stretch by ${seconds}s ${frames}f`;
    } else {
      return `→ Shrink by ${seconds}s ${frames}f`;
    }
  }
}
