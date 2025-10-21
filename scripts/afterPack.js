#!/usr/bin/env node

/**
 * Electron Builder afterPack hook
 * Copies the bundled Python environment into the packaged app
 */

const fs = require('fs');
const path = require('path');

exports.default = async function(context) {
  const { electronPlatformName, arch, appOutDir } = context;

  console.log(`\n🔧 afterPack hook: ${electronPlatformName} ${arch}`);
  console.log(`   App directory: ${appOutDir}\n`);

  const pythonDistDir = path.join(__dirname, '..', 'python-dist', `${electronPlatformName}-${arch}`);

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

  console.log('✅ Python environment copied successfully!\n');
};

function copyRecursiveSync(src, dest) {
  const exists = fs.existsSync(src);
  const stats = exists && fs.statSync(src);
  const isDirectory = exists && stats.isDirectory();

  if (isDirectory) {
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
    fs.copyFileSync(src, dest);
  }
}
