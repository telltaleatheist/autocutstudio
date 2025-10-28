import { Component, OnInit } from '@angular/core';
import { ElectronService } from '../../services/electron.service';

interface AssetPath {
  key: string;
  displayName: string;
  currentPath: string;
  isValid: boolean;
  category: string;
}

@Component({
  selector: 'app-relinking',
  standalone: false,
  templateUrl: './relinking.component.html',
  styleUrl: './relinking.component.scss'
})
export class RelinkingComponent implements OnInit {
  assetsFolder: string = '';
  assets: AssetPath[] = [];
  isSearching: boolean = false;
  searchProgress: string = '';

  constructor(private electronService: ElectronService) {}

  async ngOnInit() {
    await this.loadAssetPaths();
  }

  async loadAssetPaths() {
    try {
      // Load current asset paths from backend
      let backgrounds: any = {};
      let borders: any = {};

      if (this.electronService.isElectron()) {
        const result = await this.electronService.getAssetConfig();
        console.log('Asset config result:', result);

        if (result.success && result.assetPaths) {
          backgrounds = result.assetPaths.backgrounds || {};
          borders = result.assetPaths.borders || {};
        } else {
          console.warn('Failed to load asset config from backend:', result.error);
        }
      }

      // Always populate the assets list (even if paths are empty)
      this.assets = [
        // Backgrounds
        {
          key: 'space_background',
          displayName: 'Space Background',
          currentPath: backgrounds?.space_background || '',
          isValid: false,
          category: 'backgrounds'
        },

          // CAM DC borders
          {
            key: 'cam_dc_top_left',
            displayName: 'Top Left (Cam 1)',
            currentPath: borders?.cam_dc?.top_left || '',
            isValid: false,
            category: 'cam_dc_borders'
          },
          {
            key: 'cam_dc_bottom_right',
            displayName: 'Bottom Right (Cam 2)',
            currentPath: borders?.cam_dc?.bottom_right || '',
            isValid: false,
            category: 'cam_dc_borders'
          },

          // GS borders
          {
            key: 'gs_bottom_left',
            displayName: 'Bottom Left (Cam 1)',
            currentPath: borders?.gs?.bottom_left || '',
            isValid: false,
            category: 'gs_borders'
          },
          {
            key: 'gs_bottom_right',
            displayName: 'Bottom Right (Game)',
            currentPath: borders?.gs?.bottom_right || '',
            isValid: false,
            category: 'gs_borders'
          },
          {
            key: 'gs_top_left',
            displayName: 'Top Left (Screen)',
            currentPath: borders?.gs?.top_left || '',
            isValid: false,
            category: 'gs_borders'
          },

          // GS DC borders
          {
            key: 'gs_dc_bottom_left',
            displayName: 'Bottom Left (Cam 1)',
            currentPath: borders?.gs_dc?.bottom_left || '',
            isValid: false,
            category: 'gs_dc_borders'
          },
          {
            key: 'gs_dc_bottom_right',
            displayName: 'Bottom Right (Game)',
            currentPath: borders?.gs_dc?.bottom_right || '',
            isValid: false,
            category: 'gs_dc_borders'
          },
          {
            key: 'gs_dc_top_left',
            displayName: 'Top Left (Screen)',
            currentPath: borders?.gs_dc?.top_left || '',
            isValid: false,
            category: 'gs_dc_borders'
          },
          {
            key: 'gs_dc_top_right',
            displayName: 'Top Right (Cam 2)',
            currentPath: borders?.gs_dc?.top_right || '',
            isValid: false,
            category: 'gs_dc_borders'
          },

          // SSB borders
          {
            key: 'ssb_top_left',
            displayName: 'Top Left (Cam)',
            currentPath: borders?.ssb?.top_left || '',
            isValid: false,
            category: 'ssb_borders'
          },
          {
            key: 'ssb_bottom_right',
            displayName: 'Bottom Right (Screen)',
            currentPath: borders?.ssb?.bottom_right || '',
            isValid: false,
            category: 'ssb_borders'
          },

          // SSB DC borders
          {
            key: 'ssb_dc_top_left',
            displayName: 'Top Left (Cam 1)',
            currentPath: borders?.ssb_dc?.top_left || '',
            isValid: false,
            category: 'ssb_dc_borders'
          },
          {
            key: 'ssb_dc_bottom_left',
            displayName: 'Bottom Left (Cam 2)',
            currentPath: borders?.ssb_dc?.bottom_left || '',
            isValid: false,
            category: 'ssb_dc_borders'
          },
          {
            key: 'ssb_dc_bottom_right',
            displayName: 'Bottom Right (Screen)',
            currentPath: borders?.ssb_dc?.bottom_right || '',
            isValid: false,
            category: 'ssb_dc_borders'
          }
        ];

      // Check validity of each path
      await this.validateAllPaths();
    } catch (error) {
      console.error('Error loading asset paths:', error);
      // Even if there's an error, ensure we have an empty assets array
      if (this.assets.length === 0) {
        console.warn('Assets array is empty after error, initializing with empty paths');
        await this.loadAssetPaths();
      }
    }
  }

  async validateAllPaths() {
    for (const asset of this.assets) {
      if (asset.currentPath) {
        const result = await this.electronService.checkFileExists(asset.currentPath);
        asset.isValid = result.exists;
      }
    }
  }

  async selectAssetsFolder() {
    const result = await this.electronService.selectDirectory({
      title: 'Select Assets Folder'
    });

    if (!result.canceled && result.filePaths.length > 0) {
      this.assetsFolder = result.filePaths[0];
      await this.autoRelinkAssets();
    }
  }

  async autoRelinkAssets() {
    // Try to find matching files in the selected folder (recursively)
    if (!this.assetsFolder) return;

    this.isSearching = true;
    this.searchProgress = 'Searching recursively for asset files...';

    try {
      // Collect all filenames we're searching for
      const filenames = this.assets
        .map(asset => this.getFilename(asset.currentPath))
        .filter(filename => filename !== '');

      console.log('Searching for files:', filenames);

      // Use recursive search
      const result = await this.electronService.searchFilesRecursive({
        rootPath: this.assetsFolder,
        filenames: filenames,
        maxDepth: 5 // Search up to 5 levels deep
      });

      if (result.success && result.foundFiles) {
        console.log('Found files:', result.foundFiles);

        let foundCount = 0;

        // Update asset paths with found files
        for (const asset of this.assets) {
          const filename = this.getFilename(asset.currentPath);
          if (filename && result.foundFiles[filename]) {
            asset.currentPath = result.foundFiles[filename];
            asset.isValid = true;
            foundCount++;
          }
        }

        this.searchProgress = `Found ${foundCount} of ${filenames.length} files`;

        // Re-validate all paths
        await this.validateAllPaths();

        // Show result message
        if (foundCount === filenames.length) {
          alert(`Success! Found all ${foundCount} asset files.`);
        } else {
          alert(`Found ${foundCount} of ${filenames.length} files. Some assets may still need manual linking.`);
        }
      } else {
        console.error('Search failed:', result.error);
        alert(`Search failed: ${result.error || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('Error during recursive search:', error);
      alert('An error occurred during search. Check console for details.');
    } finally {
      this.isSearching = false;
      this.searchProgress = '';
    }
  }

  async selectAssetFile(asset: AssetPath) {
    console.log('selectAssetFile called for:', asset.displayName);

    const result = await this.electronService.selectFile({
      title: `Select ${asset.displayName}`,
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tiff'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    console.log('File selection result:', result);

    if (!result.canceled && result.filePaths.length > 0) {
      asset.currentPath = result.filePaths[0];
      asset.isValid = true;
      // Re-validate to ensure the file exists
      await this.validateAllPaths();
    }
  }

  getFilename(path: string): string {
    return path.split('/').pop() || '';
  }

  async saveAssetPaths() {
    try {
      // Convert assets array to the config structure
      const assetPaths = {
        backgrounds: {} as any,
        borders: {
          cam_dc: {} as any,
          gs: {} as any,
          gs_dc: {} as any,
          ssb: {} as any,
          ssb_dc: {} as any
        }
      };

      // Map assets to config structure
      this.assets.forEach(asset => {
        if (asset.category === 'backgrounds') {
          assetPaths.backgrounds[asset.key] = asset.currentPath;
        } else if (asset.category === 'cam_dc_borders') {
          const borderKey = asset.key.replace('cam_dc_', '');
          assetPaths.borders.cam_dc[borderKey] = asset.currentPath;
        } else if (asset.category === 'gs_borders') {
          const borderKey = asset.key.replace('gs_', '');
          assetPaths.borders.gs[borderKey] = asset.currentPath;
        } else if (asset.category === 'gs_dc_borders') {
          const borderKey = asset.key.replace('gs_dc_', '');
          assetPaths.borders.gs_dc[borderKey] = asset.currentPath;
        } else if (asset.category === 'ssb_borders') {
          const borderKey = asset.key.replace('ssb_', '');
          assetPaths.borders.ssb[borderKey] = asset.currentPath;
        } else if (asset.category === 'ssb_dc_borders') {
          const borderKey = asset.key.replace('ssb_dc_', '');
          assetPaths.borders.ssb_dc[borderKey] = asset.currentPath;
        }
      });

      // Save to backend
      const result = await this.electronService.saveAssetConfig(assetPaths);

      if (result.success) {
        alert('Asset paths saved successfully!');
      } else {
        alert(`Failed to save asset paths: ${result.error}`);
      }
    } catch (error) {
      console.error('Error saving asset paths:', error);
      alert('Failed to save asset paths. Check console for details.');
    }
  }

  async resetToDefaults() {
    if (confirm('Are you sure you want to reset all asset paths to defaults?')) {
      await this.loadAssetPaths();
    }
  }

  get allPathsValid(): boolean {
    return this.assets.every(a => a.isValid);
  }

  get invalidCount(): number {
    return this.assets.filter(a => !a.isValid).length;
  }
}
