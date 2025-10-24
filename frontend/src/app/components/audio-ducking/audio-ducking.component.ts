import { Component } from '@angular/core';
import { ElectronService } from '../../services/electron.service';

@Component({
  selector: 'app-audio-ducking',
  standalone: false,
  templateUrl: './audio-ducking.component.html',
  styleUrl: './audio-ducking.component.scss'
})
export class AudioDuckingComponent {
  audio1Path = '';
  audio2Path = '';
  duckingMode: 'duck1' | 'duck2' | 'mutual' = 'mutual';
  threshold = -40;
  isProcessing = false;
  statusMessage = 'Ready to process';
  outputFiles: string[] = [];

  constructor(private electronService: ElectronService) {}

  async selectAudio1() {
    try {
      const result = await this.electronService.selectFile({
        title: 'Select Audio File 1',
        filters: [
          { name: 'Audio Files', extensions: ['wav', 'mp3', 'aac', 'flac', 'ogg', 'm4a'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });

      if (!result.canceled && result.filePaths.length > 0) {
        this.audio1Path = result.filePaths[0];
      }
    } catch (error) {
      console.error('Error selecting audio file 1:', error);
      alert('Error selecting file: ' + error);
    }
  }

  async selectAudio2() {
    try {
      const result = await this.electronService.selectFile({
        title: 'Select Audio File 2',
        filters: [
          { name: 'Audio Files', extensions: ['wav', 'mp3', 'aac', 'flac', 'ogg', 'm4a'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });

      if (!result.canceled && result.filePaths.length > 0) {
        this.audio2Path = result.filePaths[0];
      }
    } catch (error) {
      console.error('Error selecting audio file 2:', error);
      alert('Error selecting file: ' + error);
    }
  }

  async processDucking() {
    if (!this.audio1Path || !this.audio2Path) {
      alert('Please select both audio files.');
      return;
    }

    this.isProcessing = true;
    this.statusMessage = 'Processing audio ducking...';
    this.outputFiles = [];

    try {
      const result = await this.electronService.processAudioDucking({
        audio1: this.audio1Path,
        audio2: this.audio2Path,
        mode: this.duckingMode,
        threshold: this.threshold
      });

      if (result.success) {
        this.outputFiles = result.outputFiles || [];
        this.statusMessage = `Success! Created ${this.outputFiles.length} ducked audio file(s)`;
      } else {
        this.statusMessage = 'Error: ' + (result.error || 'Unknown error');
        alert('Error processing audio ducking: ' + result.error);
      }
    } catch (error) {
      console.error('Error processing ducking:', error);
      this.statusMessage = 'Error: ' + error;
      alert('Error processing audio ducking: ' + error);
    } finally {
      this.isProcessing = false;
    }
  }
}
