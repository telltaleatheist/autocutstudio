import { Component, OnInit } from '@angular/core';
import { ElectronService } from '../../services/electron.service';

interface DriftCategory {
  enabled: boolean;
  speed_factor: number;
  applies_to: string[];
  description: string;
}

interface DriftConfig {
  vmix_outputs: DriftCategory;
  vmix_sources: DriftCategory;
  soundboard: DriftCategory;
}

@Component({
  selector: 'app-settings',
  standalone: false,
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss'
})
export class SettingsComponent implements OnInit {
  config: DriftConfig | null = null;
  loading = false;
  saveSuccess = false;
  saveError: string | null = null;

  constructor(private electronService: ElectronService) {}

  async ngOnInit() {
    await this.loadConfig();
  }

  async loadConfig() {
    this.loading = true;
    this.saveError = null;
    try {
      // The main process returns either the legacy raw config object
      // ({ vmix_outputs, vmix_sources, soundboard }) or an error envelope
      // ({ success: false, error }) for corrupt/unreadable config files.
      const result: any = await this.electronService.getDriftCorrections();

      if (result && result.success === false) {
        console.error('Failed to load drift corrections:', result.error);
        this.saveError = (result.error || 'Failed to load configuration') + '. Using defaults.';
        this.resetToDefaults();
      } else if (this.isValidDriftConfig(result)) {
        this.config = result;
      } else {
        console.error('Drift corrections config has an unexpected shape:', result);
        this.saveError = 'Configuration was invalid or incomplete. Using defaults.';
        this.resetToDefaults();
      }
    } catch (error) {
      console.error('Failed to load drift corrections:', error);
      this.saveError = 'Failed to load configuration. Using defaults.';
      this.resetToDefaults();
    } finally {
      this.loading = false;
    }
  }

  /**
   * Validate that a loaded config has the three drift categories as objects with
   * an applies_to array, so template bindings (e.g. applies_to.join) don't explode.
   */
  private isValidDriftConfig(config: any): config is DriftConfig {
    return !!config
      && typeof config === 'object'
      && this.isDriftCategory(config.vmix_outputs)
      && this.isDriftCategory(config.vmix_sources)
      && this.isDriftCategory(config.soundboard);
  }

  private isDriftCategory(category: any): boolean {
    return !!category && typeof category === 'object' && Array.isArray(category.applies_to);
  }

  async saveConfig() {
    if (!this.config) return;

    this.loading = true;
    this.saveSuccess = false;
    this.saveError = null;

    try {
      const result = await this.electronService.saveDriftCorrections(this.config);
      if (result.success) {
        this.saveSuccess = true;
        setTimeout(() => this.saveSuccess = false, 3000);
      } else {
        this.saveError = result.error || 'Failed to save configuration';
      }
    } catch (error) {
      console.error('Failed to save drift corrections:', error);
      this.saveError = 'Failed to save configuration';
    } finally {
      this.loading = false;
    }
  }

  resetToDefaults() {
    this.config = {
      vmix_outputs: {
        enabled: true,
        speed_factor: 1.0,
        applies_to: ['mic1', 'mic2', 'mic3', 'mic4', 'screen_audio', 'bluetooth', 'cam', 'master'],
        description: 'vMix outputs converted to 29.97fps'
      },
      vmix_sources: {
        enabled: true,
        speed_factor: 0.9999763884,
        applies_to: ['screen_capture_video', 'game_capture_video'],
        description: 'vMix direct source recordings'
      },
      soundboard: {
        enabled: true,
        speed_factor: 1.0000158402,
        applies_to: ['sound_effects'],
        description: 'External soundboard device'
      }
    };
  }

  getAppliesTo(category: DriftCategory): string {
    return category.applies_to.join(', ');
  }

  getDriftPercentage(speedFactor: number): string {
    const percentage = Math.abs((speedFactor - 1.0) * 100);
    const direction = speedFactor > 1.0 ? 'speedup' : 'slowdown';
    return `${percentage.toFixed(5)}% ${direction} needed`;
  }
}
