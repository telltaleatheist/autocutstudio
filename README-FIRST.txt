╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║              AutoCutStudio Installation Guide                ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝

STEP 1: Install Required Dependencies
───────────────────────────────────────────────────────────────

Before you can use AutoCutStudio, you need to install some tools
on your Mac. We've made this super easy!

1. Open Terminal (find it in Applications > Utilities)

2. Drag and drop the "install-dependencies.sh" file into Terminal

3. Press Enter

4. Follow the prompts

The installer will:
  ✓ Check what you already have
  ✓ Install only what's missing
  ✓ Verify everything works
  ✓ Give you clear instructions

This works on both Intel and Apple Silicon Macs!


STEP 2: Install AutoCutStudio App
───────────────────────────────────────────────────────────────

After dependencies are installed:

1. Find the AutoCutStudio-X.X.X.dmg file
2. Double-click to open it
3. Drag AutoCutStudio to your Applications folder
4. Launch from Applications

That's it!


What Gets Installed?
───────────────────────────────────────────────────────────────

The dependency installer will set up:

  • Homebrew - Package manager for Mac (if not already installed)
  • Python 3.9+ - Required to run the video processing scripts
  • FFmpeg - Video and audio processing tool
  • PyYAML - Configuration file reader
  • auto-editor - Automatic video editing tool


Troubleshooting
───────────────────────────────────────────────────────────────

Problem: "auto-editor: command not found"
Solution: Close and reopen your Terminal, then try again

Problem: "ModuleNotFoundError: No module named 'yaml'"
Solution: Run: pip3 install --user pyyaml

Problem: The app won't open
Solution: Right-click the app, select "Open", then click "Open"
          in the security dialog (only needed first time)

Problem: "Workflow failed"
Solution: Run the installer again - it will show what's missing


Still Having Issues?
───────────────────────────────────────────────────────────────

1. Run the installer again - it's safe to run multiple times
2. Read INSTALLATION.md for detailed troubleshooting
3. Make sure you're running macOS 10.15 or later


Need to Uninstall?
───────────────────────────────────────────────────────────────

To remove AutoCutStudio:
  - Drag the app from Applications to Trash

To remove dependencies (optional):
  pip3 uninstall pyyaml auto-editor
  brew uninstall ffmpeg python3

Note: Don't uninstall Homebrew, Python, or FFmpeg if other apps
      might be using them!
