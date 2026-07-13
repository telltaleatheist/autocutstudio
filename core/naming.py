"""Shared filename conventions.

The soundboard check previously existed in four places with three
different definitions — the loosest one (`'sb' in filename`) classified
any filename containing the letters "sb" as a soundboard recording and
applied the soundboard clock-drift speed factor to it. One definition,
used everywhere, keeps classification (and therefore the exact timing
numbers applied to a file) consistent across the pipeline.
"""

from pathlib import Path


def is_soundboard_filename(file_path: str) -> bool:
    """True if the file name follows the soundboard recording convention.

    Matches names containing 'sb.' (e.g. '2025-10-23 screen audio sb.wav')
    or ending in 'sb.wav'. Deliberately does NOT match a bare 'sb'
    substring anywhere in the name.
    """
    if not file_path:
        return False
    name = Path(file_path).name.lower()
    return 'sb.' in name or name.endswith('sb.wav')
