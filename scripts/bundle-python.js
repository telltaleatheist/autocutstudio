#!/usr/bin/env node

/**
 * Script to bundle Python environment with Electron app
 * This creates a self-contained app that doesn't depend on system Python/conda
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ARCH = process.env.BUILD_ARCH || process.arch; // 'arm64' or 'x64'
const PLATFORM = process.platform; // 'darwin', 'win32', 'linux'

console.log(`\n🐍 Bundling Python environment for ${PLATFORM} ${ARCH}...\n`);

// Determine conda path based on architecture
const getCondaPath = () => {
  if (PLATFORM === 'darwin') {
    const possiblePaths = [];

    if (ARCH === 'arm64') {
      possiblePaths.push('/opt/homebrew/Caskroom/miniconda/base');
    } else {
      // x64 - try multiple locations
      possiblePaths.push(
        '/usr/local/Caskroom/miniconda/base',
        path.join(process.env.HOME, 'miniconda3-x64'),
        path.join(process.env.HOME, '.miniconda3-x64')
      );
    }

    // Find the first path that exists
    for (const condaPath of possiblePaths) {
      if (fs.existsSync(condaPath)) {
        console.log(`✅ Found conda installation: ${condaPath}`);
        return condaPath;
      }
    }

    throw new Error(`No conda installation found for ${ARCH}. Tried: ${possiblePaths.join(', ')}`);
  }
  // Add Windows/Linux paths if needed
  throw new Error(`Unsupported platform: ${PLATFORM}`);
};

const CONDA_BASE = getCondaPath();
const ENV_NAME = 'autocutstudio';
const SOURCE_ENV = path.join(CONDA_BASE, 'envs', ENV_NAME);

// Create python directory in build resources
const PYTHON_DIR = path.join(__dirname, '..', 'python-dist', `${PLATFORM}-${ARCH}`);

if (!fs.existsSync(PYTHON_DIR)) {
  fs.mkdirSync(PYTHON_DIR, { recursive: true });
}

console.log(`📦 Exporting conda environment: ${ENV_NAME}`);
console.log(`   Source: ${SOURCE_ENV}`);
console.log(`   Target: ${PYTHON_DIR}\n`);

try {
  // Check if source environment exists
  if (!fs.existsSync(SOURCE_ENV)) {
    throw new Error(`Conda environment not found: ${SOURCE_ENV}`);
  }

  // Use conda-pack to create portable environment
  console.log('Installing conda-pack if not present...');
  try {
    execSync(`${CONDA_BASE}/bin/conda install -y -c conda-forge conda-pack`, {
      stdio: 'inherit'
    });
  } catch (e) {
    console.log('conda-pack already installed or failed to install, continuing...');
  }

  // Pack the environment
  const packFile = path.join(PYTHON_DIR, 'env.tar.gz');
  console.log(`\n📦 Packing environment to: ${packFile}`);

  execSync(
    `${CONDA_BASE}/bin/conda-pack -n ${ENV_NAME} -o ${packFile}`,
    { stdio: 'inherit' }
  );

  // Extract the packed environment
  console.log('\n📂 Extracting environment...');
  const extractDir = path.join(PYTHON_DIR, 'env');
  if (fs.existsSync(extractDir)) {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
  fs.mkdirSync(extractDir, { recursive: true });

  execSync(`tar -xzf ${packFile} -C ${extractDir}`, {
    stdio: 'inherit'
  });

  // Remove the tar file to save space
  fs.unlinkSync(packFile);

  // Activate the environment (run conda-unpack)
  console.log('\n⚙️  Activating portable environment...');
  // conda-unpack is a shell script that needs python from the extracted env
  const pythonBin = path.join(extractDir, 'bin', 'python');
  const condaUnpackScript = path.join(extractDir, 'bin', 'conda-unpack');

  if (fs.existsSync(condaUnpackScript)) {
    execSync(`${pythonBin} ${condaUnpackScript}`, {
      stdio: 'inherit',
      env: {
        ...process.env,
        PATH: `${path.join(extractDir, 'bin')}:${process.env.PATH}`
      }
    });
  } else {
    console.log('⚠️  conda-unpack not found, skipping activation step');
  }

  // Remove macOS resource fork files that cause packaging issues
  console.log('\n🧹 Removing macOS resource fork files...');
  try {
    execSync(`find ${extractDir} -name "._*" -type f -delete`, {
      stdio: 'inherit'
    });
    console.log('✅ Cleaned up resource fork files');
  } catch (e) {
    console.log('⚠️  No resource fork files found or cleanup failed (non-fatal)');
  }

  // Create a simple launcher script
  const launcherScript = `#!/bin/bash
# AutoCutStudio Python Launcher
SCRIPT_DIR="$( cd "$( dirname "\${BASH_SOURCE[0]}" )" && pwd )"
export PATH="$SCRIPT_DIR/env/bin:$PATH"
export PYTHONHOME="$SCRIPT_DIR/env"
export CONDA_PREFIX="$SCRIPT_DIR/env"
export CONDA_DEFAULT_ENV="autocutstudio"
exec "$SCRIPT_DIR/env/bin/python3" "$@"
`;

  const launcherPath = path.join(PYTHON_DIR, 'python-launcher.sh');
  fs.writeFileSync(launcherPath, launcherScript);
  fs.chmodSync(launcherPath, 0o755);

  console.log('\n✅ Python environment bundled successfully!');
  console.log(`   Location: ${PYTHON_DIR}`);
  console.log(`   Launcher: ${launcherPath}\n`);

} catch (error) {
  console.error('\n❌ Error bundling Python environment:');
  console.error(error.message);
  process.exit(1);
}
