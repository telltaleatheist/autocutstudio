import { Component, OnInit } from '@angular/core';
import { Router, NavigationEnd } from '@angular/router';
import { filter } from 'rxjs/operators';
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
  currentTheme: 'light' | 'dark' = 'dark';

  // First-run setup gate (asset downloads). The app UI is hidden until this is true.
  setupReady = false;

  // Chromeless mode: the manual-alignment wizard runs the same Angular app in a
  // SECOND window, deep-linked to /alignment. In that window we hide the sidebar and
  // bypass the first-run setup gate (assets were already ensured by the main window).
  isChromeless = false;

  // Dependency status
  showDependencyBanner = false;
  missingSystemDeps: string[] = [];
  missingPythonPackages: string[] = [];
  pythonPackagesInstalling = false;
  showInstallDialog = false;

  constructor(private electronService: ElectronService, private router: Router) {
    // Detect the chromeless routes synchronously so the setup overlay/sidebar never
    // flash in a second window. window.location.hash is reliable at construction
    // under HashLocationStrategy; router events keep it in sync thereafter. Both the
    // manual-alignment wizard (/alignment) and the timeline editor (/editor) run the
    // same Angular app in their own chromeless windows.
    // NB: /editor must NOT match the main-window launcher route /editor-launcher, hence
    // the negative lookahead (no trailing word char / hyphen after "editor").
    const detect = (url: string) => url.includes('/alignment') || /\/editor(?![-\w])/.test(url);
    if (detect(window.location.hash) || detect(window.location.pathname)) {
      this.isChromeless = true;
      this.setupReady = true; // bypass the first-run gate in the wizard window
    }
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => {
        this.isChromeless = detect(e.urlAfterRedirects);
        if (this.isChromeless) this.setupReady = true;
      });
  }

  async ngOnInit() {
    // Load saved theme
    const savedTheme = localStorage.getItem('theme') as 'light' | 'dark' || 'dark';
    this.setTheme(savedTheme);

    // Get app version
    if (this.electronService.isElectron()) {
      this.appVersion = await this.electronService.getAppVersion();

      // Listen for dependency status updates
      (window as any).electron?.onDependencyStatus?.((status: any) => {
        console.log('[Dependency Status]', status);

        // Only show banner if there are ACTUALLY missing dependencies
        const hasMissingSystemDeps = status.missingSystemDeps && status.missingSystemDeps.length > 0;
        const hasMissingPythonPackages = status.missingPythonPackages && status.missingPythonPackages.length > 0;

        if (hasMissingSystemDeps || hasMissingPythonPackages) {
          this.missingSystemDeps = status.missingSystemDeps || [];
          this.missingPythonPackages = status.missingPythonPackages || [];

          // Check if any Python packages are currently being installed
          const pythonPackagesInfo = status.pythonPackagesInfo || {};
          const anyInstalling = Object.values(pythonPackagesInfo).some(
            (info: any) => info.installAttempted && !info.available
          );

          if (anyInstalling) {
            // Installation in progress
            this.pythonPackagesInstalling = true;
            this.showDependencyBanner = true;
            this.showInstallDialog = false;
          } else if (hasMissingPythonPackages) {
            // Missing Python packages - show install dialog to ask user
            this.pythonPackagesInstalling = false;
            this.showInstallDialog = true;
            this.showDependencyBanner = false;
          } else if (hasMissingSystemDeps) {
            // Only system deps missing - show banner
            this.pythonPackagesInstalling = false;
            this.showDependencyBanner = true;
            this.showInstallDialog = false;

            // Auto-dismiss banner after 10 seconds for system deps
            setTimeout(() => {
              if (!this.pythonPackagesInstalling) {
                this.dismissDependencyBanner();
              }
            }, 10000);
          }
        } else {
          // Everything is available - hide everything
          this.showDependencyBanner = false;
          this.pythonPackagesInstalling = false;
          this.showInstallDialog = false;
        }
      });
    }
  }

  onSetupComplete() {
    this.setupReady = true;
  }

  dismissDependencyBanner() {
    this.showDependencyBanner = false;
  }

  dismissInstallDialog() {
    this.showInstallDialog = false;
  }

  async installPythonPackages() {
    // User confirmed - start installation
    this.showInstallDialog = false;
    this.pythonPackagesInstalling = true;
    this.showDependencyBanner = true;

    // Trigger installation via IPC
    try {
      const result = await this.electronService.installPythonPackages(this.missingPythonPackages);
      if (result?.success) {
        console.log('Python packages installed successfully');
        // Hide banner after short delay
        setTimeout(() => {
          this.pythonPackagesInstalling = false;
          this.showDependencyBanner = false;
        }, 2000);
      } else {
        console.error('Failed to install Python packages:', result?.error);
        alert(`Failed to install packages: ${result?.error || 'Unknown error'}`);
        this.pythonPackagesInstalling = false;
        this.showDependencyBanner = false;
      }
    } catch (error) {
      console.error('Error installing packages:', error);
      alert('Error installing packages. Check console for details.');
      this.pythonPackagesInstalling = false;
      this.showDependencyBanner = false;
    }
  }

  toggleTheme() {
    console.log('Current theme before toggle:', this.currentTheme);
    const newTheme = this.currentTheme === 'light' ? 'dark' : 'light';
    console.log('New theme:', newTheme);
    this.setTheme(newTheme);
  }

  setTheme(theme: 'light' | 'dark') {
    console.log('Setting theme to:', theme);
    this.currentTheme = theme;
    document.body.setAttribute('data-theme', theme);
    console.log('Body data-theme attribute:', document.body.getAttribute('data-theme'));
    localStorage.setItem('theme', theme);
  }
}
