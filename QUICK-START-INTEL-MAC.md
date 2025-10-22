# Quick Start for Intel Mac

## The Problem You Had

The error `ModuleNotFoundError: No module named 'yaml'` means Python doesn't have the required packages installed.

## The Solution

Run the automatic installer script - it will install everything you need.

## Step-by-Step Instructions

### 1. Get the installer script

Copy the `install-dependencies.sh` file to your Intel Mac.

### 2. Open Terminal

- Press `Cmd + Space`
- Type "Terminal"
- Press Enter

### 3. Navigate to where you saved the installer

```bash
cd ~/Downloads   # if you saved it in Downloads
```

### 4. Make it executable (first time only)

```bash
chmod +x install-dependencies.sh
```

### 5. Run the installer

```bash
./install-dependencies.sh
```

### 6. Follow the prompts

- The script will check what's already installed
- It will ask if you want to install missing items
- Type `y` and press Enter to install
- Enter your password when prompted

### 7. Wait for it to finish

The script will:
- Install Homebrew (if needed)
- Install Python 3 (if needed)
- Install FFmpeg (if needed)
- Install PyYAML
- Install auto-editor
- Verify everything works

### 8. Launch AutoCutStudio

Once the installer says "All dependencies are now installed", you can:
- Open AutoCutStudio from Applications
- Run your workflow
- It should work without the "yaml" error!

## What Gets Installed

| Tool | Purpose | Size |
|------|---------|------|
| Homebrew | Package manager | ~400 MB |
| Python 3.9+ | Script runtime | ~100 MB |
| FFmpeg | Video processing | ~80 MB |
| PyYAML | Config reader | ~1 MB |
| auto-editor | Video editor | ~50 MB |

**Total:** About 600 MB

## Verify Installation

After the installer finishes, verify everything works:

```bash
# Check Python
python3 --version
# Should show: Python 3.9 or higher

# Check PyYAML
python3 -c "import yaml; print('PyYAML works!')"
# Should show: PyYAML works!

# Check auto-editor
auto-editor --version
# Should show: a version number
```

## If You Still Get Errors

### "command not found: auto-editor"

Close and reopen Terminal, then try again. Or run:

```bash
export PATH="$PATH:$(python3 -m site --user-base)/bin"
```

### "ModuleNotFoundError: No module named 'yaml'"

Install PyYAML manually:

```bash
pip3 install --user pyyaml
```

Then verify:

```bash
python3 -c "import yaml; print('Success!')"
```

### Still not working?

Run the installer again - it's safe to run multiple times:

```bash
./install-dependencies.sh
```

It will show you exactly what's missing.

## Need Help?

1. Run the installer - it will diagnose the problem
2. Check the output for specific error messages
3. Read INSTALLATION.md for detailed troubleshooting
4. Make sure you completed all prompts during installation

## Uninstalling (if needed)

To remove just the Python packages:

```bash
pip3 uninstall pyyaml auto-editor
```

To remove everything (careful - other apps might use these):

```bash
pip3 uninstall pyyaml auto-editor
brew uninstall ffmpeg python3
# Don't uninstall Homebrew unless you're sure nothing else uses it
```
