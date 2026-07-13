"""Single source of truth for loading drift correction configuration.

Previously three copies of _load_drift_config lived in audio_sync.py,
audio_processor.py and xml_utils.py, each silently falling back to
hardcoded defaults on any error. That masked two real failure modes:
a corrupt config file, and (in the packaged app) the Electron Settings
UI writing to the user config directory while Python kept reading the
bundled copy — user edits never reached the pipeline.

The Electron main process sets AUTOCUT_CONFIG_DIR to the directory the
Settings UI actually writes to. Resolution order:
1. $AUTOCUT_CONFIG_DIR/drift_corrections.json (user-edited values)
2. <repo>/config/drift_corrections.json (bundled copy)

A file that exists but cannot be parsed, or is missing required keys,
raises instead of silently substituting defaults.
"""

import json
import os
import sys
from pathlib import Path

REQUIRED_SECTIONS = ('vmix_outputs', 'vmix_sources', 'soundboard')

_logged_path = None


def get_drift_config_path() -> Path:
    """Resolve drift_corrections.json, preferring the user config dir."""
    candidates = []
    env_dir = os.environ.get('AUTOCUT_CONFIG_DIR')
    if env_dir:
        candidates.append(Path(env_dir) / 'drift_corrections.json')
    candidates.append(Path(__file__).parent.parent / 'config' / 'drift_corrections.json')

    for candidate in candidates:
        if candidate.exists():
            return candidate

    raise FileNotFoundError(
        "drift_corrections.json not found. Looked in: "
        + ", ".join(str(c) for c in candidates)
        + ". The app installation is incomplete or AUTOCUT_CONFIG_DIR points to the wrong directory."
    )


def load_drift_config() -> dict:
    """Load and validate drift correction configuration. Raises on any problem."""
    global _logged_path
    config_path = get_drift_config_path()

    try:
        with open(config_path, 'r') as f:
            config = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        raise RuntimeError(
            f"Could not read drift corrections config {config_path}: {e}. "
            "Fix or delete the file (Settings > Drift Corrections rewrites it)."
        ) from e

    for section in REQUIRED_SECTIONS:
        if section not in config:
            raise ValueError(
                f"Drift corrections config {config_path} is missing required section '{section}'"
            )
        if 'speed_factor' not in config[section]:
            raise ValueError(
                f"Drift corrections config {config_path} section '{section}' is missing 'speed_factor'"
            )

    if _logged_path != str(config_path):
        _logged_path = str(config_path)
        print(f"Drift corrections loaded from: {config_path}", file=sys.stderr)

    return config
