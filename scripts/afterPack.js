#!/usr/bin/env node

/**
 * Electron Builder afterPack hook
 * Copies the bundled Python environment into the packaged app
 */

const fs = require('fs');
const path = require('path');

exports.default = async function(context) {
  const { electronPlatformName, arch, appOutDir } = context;

  // electron-builder arch is an enum: 0=x64, 1=ia32, 2=armv7l, 3=arm64, 4=universal
  const archMap = {
    0: 'x64',
    1: 'ia32',
    2: 'armv7l',
    3: 'arm64',
    4: 'universal'
  };

  // Determine architecture from appOutDir path if enum doesn't match expectations
  let archString = archMap[arch] || arch;

  // Override architecture detection based on appOutDir path
  if (appOutDir.includes('mac-arm64')) {
    archString = 'arm64';
  } else if (appOutDir.includes('mac-x64') || (!appOutDir.includes('arm64') && electronPlatformName === 'darwin')) {
    archString = 'x64';
  }

  console.log(`\n🔧 afterPack hook: ${electronPlatformName} ${archString} (arch=${arch})`);
  console.log(`   App directory: ${appOutDir}\n`);

  const pythonDistDir = path.join(__dirname, '..', 'python-dist', `${electronPlatformName}-${archString}`);

  if (!fs.existsSync(pythonDistDir)) {
    console.warn(`⚠️  Python distribution not found: ${pythonDistDir}`);
    console.warn('   Skipping Python bundling. Run "npm run bundle:python" first.\n');
    return;
  }

  let targetDir;

  if (electronPlatformName === 'darwin') {
    // macOS: Copy into .app/Contents/Resources/
    targetDir = path.join(appOutDir, 'AutoCutStudio.app', 'Contents', 'Resources', 'python');
  } else if (electronPlatformName === 'win32') {
    // Windows: Copy into resources/
    targetDir = path.join(appOutDir, 'resources', 'python');
  } else {
    // Linux: Copy into resources/
    targetDir = path.join(appOutDir, 'resources', 'python');
  }

  console.log(`📦 Copying Python environment...`);
  console.log(`   From: ${pythonDistDir}`);
  console.log(`   To:   ${targetDir}`);

  // Create target directory
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Copy the Python environment
  copyRecursiveSync(pythonDistDir, targetDir);

  console.log('✅ Python environment copied successfully!');

  // Clean up macOS resource fork files that can cause packaging issues
  console.log('\n🧹 Cleaning up macOS resource fork files...');
  const { execSync } = require('child_process');
  try {
    execSync(`find "${targetDir}" -name "._*" -type f -delete`, { stdio: 'inherit' });
    execSync(`find "${path.dirname(targetDir)}" -name "._*" -type f -delete`, { stdio: 'inherit' });
    console.log('✅ Cleaned up resource fork files\n');
  } catch (e) {
    console.log('⚠️  Resource fork cleanup failed (non-fatal)\n');
  }
};

function copyRecursiveSync(src, dest) {
  try {
    const exists = fs.existsSync(src);
    if (!exists) return;

    const stats = fs.lstatSync(src); // Use lstat to detect symlinks

    if (stats.isSymbolicLink()) {
      // Copy symlink
      const linkTarget = fs.readlinkSync(src);
      if (fs.existsSync(dest)) {
        fs.unlinkSync(dest);
      }
      fs.symlinkSync(linkTarget, dest);
    } else if (stats.isDirectory()) {
      // Copy directory
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
      }
      fs.readdirSync(src).forEach(childItemName => {
        copyRecursiveSync(
          path.join(src, childItemName),
          path.join(dest, childItemName)
        );
      });
    } else {
      // Copy file
      fs.copyFileSync(src, dest);
      // Preserve executable bit
      if (stats.mode & 0o111) {
        fs.chmodSync(dest, stats.mode);
      }
    }
  } catch (error) {
    console.warn(`⚠️  Skipping ${src}: ${error.message}`);
  }
}
