#!/usr/bin/env node
/**
 * Test script to verify binary resolution
 * Run with: node scripts/test-binary-resolution.js
 */

const path = require('path');
const fs = require('fs');

// Mock app configuration for testing
const mockAppConfig = {
  resourcesPath: path.join(__dirname, '..'),
  isDevelopment: true
};

// Simple version of BinaryResolver for testing
class TestBinaryResolver {
  constructor() {
    // Determine platform (map to electron-builder naming)
    const platform = process.platform === 'darwin' ? 'mac' :
                     process.platform === 'win32' ? 'win' : 'linux';
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const platformDir = `${platform}-${arch}`;

    this.binariesPath = path.join(mockAppConfig.resourcesPath, 'binaries', platformDir);
    this.pythonPath = path.join(mockAppConfig.resourcesPath, 'python', platformDir);

    console.log('🖥️  Platform:', platformDir);
    console.log('📁 Binaries path:', this.binariesPath);
    console.log('📁 Python path:', this.pythonPath);
    console.log('');
  }

  findBundledBinary(binaryName) {
    const binaryPath = path.join(this.binariesPath, binaryName);

    if (fs.existsSync(binaryPath)) {
      try {
        fs.accessSync(binaryPath, fs.constants.X_OK);
        console.log(`✅ Found bundled ${binaryName}: ${binaryPath}`);
        return binaryPath;
      } catch (e) {
        console.log(`⚠️  Bundled ${binaryName} exists but is not executable: ${binaryPath}`);
        return null;
      }
    }

    console.log(`❌ Bundled ${binaryName} not found`);
    return null;
  }

  findSystemBinary(binaryName) {
    const { execSync } = require('child_process');

    try {
      const result = execSync(`which ${binaryName}`, { encoding: 'utf8' }).trim();
      if (result) {
        console.log(`✅ Found system ${binaryName}: ${result}`);
        return result;
      }
    } catch (error) {
      console.log(`❌ System ${binaryName} not found`);
    }

    return null;
  }

  getFfmpegPath() {
    console.log('\n🔍 Resolving FFmpeg...');
    return this.findBundledBinary('ffmpeg') || this.findSystemBinary('ffmpeg') || 'ffmpeg';
  }

  getFfprobePath() {
    console.log('\n🔍 Resolving FFprobe...');
    return this.findBundledBinary('ffprobe') || this.findSystemBinary('ffprobe') || 'ffprobe';
  }

  getPythonPath() {
    console.log('\n🔍 Resolving Python...');

    // Check for bundled Python
    const bundledPython = path.join(this.pythonPath, 'python-runtime', 'bin', 'python3');
    if (fs.existsSync(bundledPython)) {
      console.log(`✅ Found bundled Python: ${bundledPython}`);
      return bundledPython;
    }
    console.log(`❌ Bundled Python not found at: ${bundledPython}`);

    // Check for conda
    const condaPython = '/opt/homebrew/Caskroom/miniconda/base/envs/autocutstudio/bin/python3';
    if (fs.existsSync(condaPython)) {
      console.log(`✅ Found conda Python: ${condaPython}`);
      return condaPython;
    }
    console.log(`❌ Conda Python not found`);

    // Fall back to system
    return this.findSystemBinary('python3') || 'python3';
  }

  getAutoEditorPath() {
    console.log('\n🔍 Resolving auto-editor...');

    const bundledAutoEditor = path.join(this.pythonPath, 'python-runtime', 'bin', 'auto-editor');
    if (fs.existsSync(bundledAutoEditor)) {
      console.log(`✅ Found bundled auto-editor: ${bundledAutoEditor}`);
      return bundledAutoEditor;
    }
    console.log(`❌ Bundled auto-editor not found`);

    return this.findSystemBinary('auto-editor') || 'auto-editor';
  }
}

// Run tests
console.log('🧪 Testing Binary Resolution\n');
console.log('='.repeat(60));

const resolver = new TestBinaryResolver();

console.log('\n' + '='.repeat(60));
console.log('📊 RESULTS\n');

const ffmpegPath = resolver.getFfmpegPath();
const ffprobePath = resolver.getFfprobePath();
const pythonPath = resolver.getPythonPath();
const autoEditorPath = resolver.getAutoEditorPath();

console.log('\n' + '='.repeat(60));
console.log('✨ SUMMARY\n');

console.log(`FFmpeg:      ${ffmpegPath}`);
console.log(`FFprobe:     ${ffprobePath}`);
console.log(`Python:      ${pythonPath}`);
console.log(`auto-editor: ${autoEditorPath}`);

console.log('\n' + '='.repeat(60));

// Check versions
console.log('\n🔬 Version Check\n');

const { execSync } = require('child_process');

try {
  const ffmpegVersion = execSync(`"${ffmpegPath}" -version 2>&1 | head -n 1`, { encoding: 'utf8' }).trim();
  console.log(`✅ FFmpeg: ${ffmpegVersion}`);
} catch (e) {
  console.log(`❌ FFmpeg version check failed`);
}

try {
  const ffprobeVersion = execSync(`"${ffprobePath}" -version 2>&1 | head -n 1`, { encoding: 'utf8' }).trim();
  console.log(`✅ FFprobe: ${ffprobeVersion}`);
} catch (e) {
  console.log(`❌ FFprobe version check failed`);
}

try {
  const pythonVersion = execSync(`"${pythonPath}" --version 2>&1`, { encoding: 'utf8' }).trim();
  console.log(`✅ Python: ${pythonVersion}`);
} catch (e) {
  console.log(`❌ Python version check failed`);
}

try {
  const autoEditorVersion = execSync(`"${autoEditorPath}" --version 2>&1`, { encoding: 'utf8' }).trim();
  console.log(`✅ auto-editor: ${autoEditorVersion}`);
} catch (e) {
  console.log(`❌ auto-editor version check failed`);
}

console.log('\n' + '='.repeat(60));
console.log('\n✅ Binary resolution test complete!\n');
