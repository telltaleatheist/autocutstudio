import { Component, OnInit } from '@angular/core';
import { ElectronService } from './services/electron.service';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  standalone: false,
  styleUrl: './app.component.scss'
})
export class AppComponent implements OnInit {
  title = 'AutoCutStudio';
  appVersion = '';
  currentTheme: 'light' | 'dark' = 'light';

  // Dependency status
  showDependencyBanner = false;
  missingSystemDeps: string[] = [];
  missingPythonPackages: string[] = [];
  pythonPackagesInstalling = false;

  constructor(private electronService: ElectronService) {}

  async ngOnInit() {
    // Load saved theme
    const savedTheme = localStorage.getItem('theme') as 'light' | 'dark' || 'light';
    this.setTheme(savedTheme);

    // Get app version
    if (this.electronService.isElectron()) {
      this.appVersion = await this.electronService.getAppVersion();

      // Listen for dependency status updates
      (window as any).electron?.onDependencyStatus?.((status: any) => {
        if (!status.allAvailable) {
          this.showDependencyBanner = true;
          this.missingSystemDeps = status.missingSystemDeps || [];
          this.missingPythonPackages = status.missingPythonPackages || [];

          // Auto-install Python packages if they're the only thing missing
          if (this.missingSystemDeps.length === 0 && this.missingPythonPackages.length > 0) {
            this.autoInstallPythonPackages();
          }
        }
      });
    }
  }

  async autoInstallPythonPackages() {
    // Python packages will be auto-installed by the dependency service
    // Just show a message to the user
    this.pythonPackagesInstalling = true;
    console.log('Python packages are being installed automatically...');
  }

  dismissDependencyBanner() {
    this.showDependencyBanner = false;
  }

  toggleTheme() {
    const newTheme = this.currentTheme === 'light' ? 'dark' : 'light';
    this.setTheme(newTheme);
  }

  setTheme(theme: 'light' | 'dark') {
    this.currentTheme = theme;
    document.body.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }
}
