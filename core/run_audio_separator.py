#!/usr/bin/env python
"""Launcher for audio-separator's CLI.

Two reasons this exists instead of a direct invocation:
  1. The `audio-separator` console script maps to audio_separator.utils.cli:main,
     but that module has NO `if __name__ == '__main__'` guard — so
     `python -m audio_separator.utils.cli` imports it and exits without running
     anything (silent no-op, exit 0). Calling main() explicitly is required.
  2. The pip-generated `audio-separator.exe` launcher bakes an absolute
     interpreter path at install time, which breaks once the env is extracted
     and relocated (the same stale-shebang trap as urvc.exe).

So the bridge spawns `<env python> run_audio_separator.py <args>` and main()
reads them from sys.argv.
"""
from audio_separator.utils.cli import main

main()
