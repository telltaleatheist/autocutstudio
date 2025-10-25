"""
Automatic dependency installer for audio sync features.

This module handles automatic installation of required packages (numpy, scipy, librosa)
when they are not available in the current Python environment.
"""

import subprocess
import sys
import importlib.util


def is_package_installed(package_name):
    """Check if a package is installed."""
    spec = importlib.util.find_spec(package_name)
    return spec is not None


def install_package(package_name, pip_name=None):
    """Install a package using pip.

    Args:
        package_name: Name used for import checks
        pip_name: Name used for pip install (defaults to package_name)
    """
    if pip_name is None:
        pip_name = package_name

    print(f"Installing {package_name}...", end=" ", flush=True)
    try:
        result = subprocess.run(
            [sys.executable, "-m", "pip", "install", "--quiet", pip_name],
            capture_output=True,
            text=True
        )

        if result.returncode == 0:
            print("✓")
            return True
        else:
            print("✗")
            # Check for Python version incompatibility
            if "only versions" in result.stderr or "Python version" in result.stderr:
                print(f"  → {package_name} is not compatible with Python {sys.version_info.major}.{sys.version_info.minor}")
                print(f"  → Please use Python 3.10-3.13 for audio sync features")
            else:
                print(f"  → Error: {result.stderr.strip()[:200]}")
            return False
    except Exception as e:
        print("✗")
        print(f"  → Exception: {e}")
        return False


def check_and_install_dependencies(interactive=True):
    """Check for required dependencies and install if missing.

    Args:
        interactive: If True, prompt user before installing. If False, auto-install.

    Returns:
        bool: True if all dependencies are available, False otherwise
    """
    required_packages = {
        'numpy': 'numpy',
        'scipy': 'scipy',
        'librosa': 'librosa'
    }

    missing_packages = []

    # Check which packages are missing
    for package_name in required_packages.keys():
        if not is_package_installed(package_name):
            missing_packages.append(package_name)

    if not missing_packages:
        return True  # All packages already installed

    print("\n" + "="*70)
    print("Audio Sync Dependencies Required")
    print("="*70)
    print(f"\nThe following packages are required for audio sync features:")
    for pkg in missing_packages:
        print(f"  - {pkg}")
    print()

    # Ask for permission if interactive
    if interactive:
        response = input("Install these packages now? [Y/n]: ").strip().lower()
        if response and response not in ('y', 'yes'):
            print("\nSkipping installation. Audio sync features will not be available.")
            return False
        print()
    else:
        print("Auto-installing required packages...\n")

    # Install missing packages
    success = True
    for package_name in missing_packages:
        pip_name = required_packages[package_name]
        if not install_package(package_name, pip_name):
            success = False

    print()
    if success:
        print("✓ All dependencies installed successfully!")
        print("="*70 + "\n")
    else:
        print("✗ Some dependencies failed to install.")
        print("\nRecommended: Use Python 3.10-3.13 in a conda environment:")
        print("  conda create -n autocutstudio python=3.11")
        print("  conda activate autocutstudio")
        print("  conda install numpy scipy")
        print("  pip install librosa")
        print("\nAudio sync features will not be available with current setup.")
        print("="*70 + "\n")

    return success


def ensure_dependencies(interactive=True):
    """Ensure all dependencies are installed, installing if necessary.

    This is a convenience function that can be called before using audio_sync.

    Args:
        interactive: If True, prompt user. If False, auto-install.

    Returns:
        bool: True if dependencies are available
    """
    try:
        # Quick check - try importing all at once
        import numpy
        import scipy
        import librosa
        return True
    except ImportError:
        # At least one is missing, run full check and install
        return check_and_install_dependencies(interactive=interactive)


if __name__ == '__main__':
    # Allow running as a standalone script
    ensure_dependencies(interactive=True)
