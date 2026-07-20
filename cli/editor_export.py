#!/usr/bin/env python3
# cli/editor_export.py
#
# Timeline Editor v2 — range-cut export (Python half of the "range-cut + export"
# feature). Builds on the v1 manifest builder (cli/editor_manifest.py).
#
# Reads a session's "<name>_compounds.zip", locates the MASTER HYBRID project FCPXML
# inside it (SAME '*_HYBRID.fcpxml' rule as editor_manifest), applies a list of CUTS
# (half-open FRAME ranges in the ORIGINAL concatenated timeline coordinates — the exact
# time base editor_manifest's manifest presents), RIPPLING the timeline so content after
# each cut shifts left by the cut's length, and writes a revised, FCPX-importable
# "<name>_HYBRID_edited.fcpxml" loose next to the zip. The ORIGINAL zip and its contents
# are never touched.
#
# Invocation:
#     python cli/editor_export.py --zip /abs/path/<name>_compounds.zip
#   with a JSON object on STDIN:
#     { "cuts": [ {"startFrame": int, "endFrame": int}, ... ] }
#
# Output (stdout, exactly one line):
#     success: {"type":"export_result","path":"/abs/.../<name>_HYBRID_edited.fcpxml",
#               "cutsApplied":N,"newDurationSeconds":float}
#     failure: {"type":"error","message":"..."}  + exit code 1
# All diagnostics go to stderr only.
#
# DOCTRINE (from CLAUDE.md + editor_manifest): numbers are sacred. Every offset/start/
# duration is composed with EXACT fractions.Fraction arithmetic; floats appear only at
# JSON emission. There are NO silent fallbacks — every ambiguous/impossible input raises
# with a message naming exactly what was wrong, and a computed value that is not
# frame-aligned (when the inputs were) is an internal error, never rounded away.
#
# XML FIDELITY: only spine children (and their anchored descendants) and each part's
# sequence 'duration' attribute change. Everything else — resources, formats, assets,
# compound <media> definitions and their internal spines, the library/event/project
# scaffolding, and every attribute not listed — is copied through and serialized via the
# SAME ElementTree flow the generators use (core.xml_utils.FCPXMLUtils.save_fcpxml:
# ET.indent + xml_declaration=True, no DOCTYPE — matching the real generated files).

import argparse
import copy
import json
import sys
import zipfile
from fractions import Fraction
from pathlib import Path
import xml.etree.ElementTree as ET

# Share the v1 helpers verbatim (do NOT duplicate or re-implement them). Adding the repo
# root to sys.path lets this run both as `python cli/editor_export.py` (script dir is on
# the path, not the repo root) and as an imported module.
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from cli.editor_manifest import (  # noqa: E402
    ManifestError,
    parse_rational,
    TIMELINE_TAGS,
    _find_master_hybrid_entry,
    _session_name,
)
from core.xml_utils import FCPXMLUtils  # noqa: E402


# ---------------------------------------------------------------------------
# Fraction <-> FCPX time string
# ---------------------------------------------------------------------------
def format_time(v):
    """Render a Fraction (seconds) as an FCPX time string. Reduced form is exact (same
    rational value); FCPX parses any N/D. parse_rational is the inverse."""
    if v == 0:
        return '0s'
    if v.denominator == 1:
        return f"{v.numerator}s"
    return f"{v.numerator}/{v.denominator}s"


def _is_frame_aligned(value, frame_seconds):
    """True iff value is an exact integer multiple of frame_seconds."""
    return (value / frame_seconds).denominator == 1


# ---------------------------------------------------------------------------
# Interval algebra (all in EXACT Fraction seconds, part-LOCAL coordinates)
# ---------------------------------------------------------------------------
def subtract_cuts(a0, a1, local_cuts):
    """Return the survivor sub-intervals of [a0, a1) not covered by any cut.

    local_cuts is sorted ascending and non-overlapping. Result sub-intervals are in
    document order and pairwise disjoint. An element fully inside a cut yields [].
    """
    survivors = []
    cur = a0
    for cs, ce in local_cuts:
        if ce <= a0 or cs >= a1:
            continue  # no overlap with [a0, a1)
        cs = max(cs, a0)
        ce = min(ce, a1)
        if cs > cur:
            survivors.append((cur, cs))
        if ce > cur:
            cur = ce
        if cur >= a1:
            break
    if cur < a1:
        survivors.append((cur, a1))
    return survivors


def make_ripple(local_cuts):
    """Ripple map for one part: rippled position of a KEPT time t equals
    t - (total cut length strictly before t). t must never fall strictly inside a cut
    (survivor boundaries never do); that would be an internal inconsistency -> raise."""
    def ripple(t):
        shift = Fraction(0)
        for cs, ce in local_cuts:
            if ce <= t:
                shift += (ce - cs)
            elif cs < t < ce:
                raise ManifestError(
                    f"internal error: rippled time {format_time(t)} falls inside cut "
                    f"[{format_time(cs)}..{format_time(ce)})")
            else:
                break  # cs >= t and cuts are sorted -> nothing further contributes
        return t - shift
    return ripple


# ---------------------------------------------------------------------------
# Spine surgery
# ---------------------------------------------------------------------------
def _set_time(el, name, value, frame_seconds, check_align, context):
    if check_align and not _is_frame_aligned(value, frame_seconds):
        raise ManifestError(
            f"{context}: internal error: computed {name} {format_time(value)} is not an "
            f"exact multiple of frameDuration {format_time(frame_seconds)}")
    el.set(name, format_time(value))


def _set_start(el, value, had_start, frame_seconds, check_align, context):
    """A 'start' of 0 with no original 'start' attribute stays absent (generator
    convention: omit zero start). Otherwise it is written."""
    if value == 0 and not had_start:
        return
    _set_time(el, 'start', value, frame_seconds, check_align, context)


def _read_span(el, context):
    """Parse (offset, start, duration, had_start) for a timeline element."""
    off_attr = el.get('offset')
    if off_attr is None:
        raise ManifestError(f"{context}: <{el.tag}> has no 'offset'; cannot ripple")
    dur_attr = el.get('duration')
    if dur_attr is None:
        raise ManifestError(f"{context}: <{el.tag}> has no 'duration'; cannot ripple")
    offset = parse_rational(off_attr, f"{context}: {el.tag} offset")
    duration = parse_rational(dur_attr, f"{context}: {el.tag} duration")
    start_attr = el.get('start')
    start = parse_rational(start_attr, f"{context}: {el.tag} start") if start_attr is not None else Fraction(0)
    return offset, start, duration, (start_attr is not None)


def _trim_children(parent_el, frame_A, win_start, win_end, frame_seconds, check_align, context):
    """Clip parent_el's anchored timeline children to [win_start, win_end) (part-local),
    IN PLACE. The window is a single survivor sub-interval of the parent piece, so it
    contains NO cut: each child is only front/back trimmed (never split), and the uniform
    ripple shift of the piece cancels in the child's parent-relative offset — so a child
    fully inside the window keeps its offset/start/duration untouched. A child that does
    not intersect the window is dropped. Non-timeline children (adjust-volume, filters,
    timeMap, ...) are anchored decorations and pass through unchanged.

    frame_A is the part-local time corresponding to local-0 of parent_el's inner frame
    (a child's absolute part-local start = frame_A + child.offset)."""
    for child in list(parent_el):
        if child.tag not in TIMELINE_TAGS:
            continue  # decoration on the parent — keep as-is
        c_ctx = f"{context} > {child.tag}"
        offset, start, duration, had_start = _read_span(child, c_ctx)
        cabs0 = frame_A + offset
        cabs1 = cabs0 + duration
        cs = max(cabs0, win_start)
        ce = min(cabs1, win_end)
        if cs >= ce:
            parent_el.remove(child)  # anchored child does not intersect this piece
            continue
        front = cs - cabs0                      # amount trimmed off the child's head
        child_frame_A = cabs0 - start           # inner frame for THIS child's own children
        _set_time(child, 'offset', offset + front, frame_seconds, check_align, c_ctx)
        _set_start(child, start + front, had_start, frame_seconds, check_align, c_ctx)
        _set_time(child, 'duration', ce - cs, frame_seconds, check_align, c_ctx)
        # Recurse: a nested timeline child (if any) is clipped to this child's window.
        _trim_children(child, child_frame_A, cs, ce, frame_seconds, check_align, c_ctx)


def split_spine_element(el, local_cuts, ripple, frame_seconds, check_align, context):
    """Split one top-level spine element into rippled pieces.

    Each survivor sub-interval [s, e) of the element's span [offset, offset+duration)
    becomes one output element:
        offset   = ripple(s)                (rippled timeline position; the spine origin
                                             is fixed at 0, so this is the only place the
                                             ripple shift appears)
        start    = start + (s - offset)     (source in-point advances by the head trim)
        duration = e - s
    then the element's anchored children are re-clipped to [s, e). An element fully inside
    a cut yields no pieces (dropped)."""
    offset, start, duration, had_start = _read_span(el, context)
    a0 = offset
    a1 = offset + duration
    parent_frame_A = a0 - start
    pieces = []
    for (s, e) in subtract_cuts(a0, a1, local_cuts):
        piece = copy.deepcopy(el)
        _set_time(piece, 'offset', ripple(s), frame_seconds, check_align, context)
        _set_start(piece, start + (s - a0), had_start, frame_seconds, check_align, context)
        _set_time(piece, 'duration', e - s, frame_seconds, check_align, context)
        _trim_children(piece, parent_frame_A, s, e, frame_seconds, check_align, context)
        pieces.append(piece)
    return pieces


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------
def _index_formats(root, entry_name):
    resources = root.find('resources')
    if resources is None:
        raise ManifestError(f"{entry_name}: no <resources> element in master hybrid project")
    return {el.get('id'): el for el in resources if el.tag == 'format' and el.get('id')}


def _frame_seconds(formats, format_id, context):
    if not format_id:
        raise ManifestError(f"{context}: sequence has no 'format' attribute; cannot derive frame duration")
    fmt = formats.get(format_id)
    if fmt is None:
        raise ManifestError(f"{context}: format {format_id!r} referenced but not defined in <resources>")
    fd = fmt.get('frameDuration')
    if not fd:
        raise ManifestError(f"{context}: format {format_id!r} has no frameDuration; frame duration cannot be derived")
    return parse_rational(fd, f"frameDuration of format {format_id!r}")


def _collect_parts(root, entry_name):
    """Return (parts, frame_seconds, total_declared).

    parts is a list of dicts (project, sequence, spine, declared) in document order —
    the SAME concatenation model editor_manifest.flatten uses (each part's spine is
    rebased to 0; parts are offset by summed DECLARED sequence durations)."""
    projects = root.findall('.//project')
    if not projects:
        raise ManifestError(f"{entry_name}: no <project> element found in master hybrid file")
    formats = _index_formats(root, entry_name)
    frame_seconds = None
    total_declared = Fraction(0)
    parts = []
    for pidx, project in enumerate(projects):
        pname = project.get('name') or f"project#{pidx + 1}"
        sequence = project.find('sequence')
        if sequence is None:
            raise ManifestError(f"{entry_name}: project {pname!r} has no <sequence>")
        fs = _frame_seconds(formats, sequence.get('format'), f"{entry_name}: project {pname!r}")
        if frame_seconds is None:
            frame_seconds = fs
        elif fs != frame_seconds:
            raise ManifestError(
                f"{entry_name}: project {pname!r} frame duration {float(fs)} disagrees with "
                f"first project's {float(frame_seconds)}")
        declared_attr = sequence.get('duration')
        if not declared_attr:
            raise ManifestError(f"{entry_name}: project {pname!r} sequence has no 'duration'")
        declared = parse_rational(declared_attr, f"sequence duration of project {pname!r}")
        spine = sequence.find('spine')
        if spine is None:
            raise ManifestError(f"{entry_name}: project {pname!r} sequence has no <spine>")
        parts.append({'name': pname, 'sequence': sequence, 'spine': spine, 'declared': declared})
        total_declared += declared
    return parts, frame_seconds, total_declared


def _validate_cuts(cuts_raw, frame_seconds, total_declared, allow_empty=False):
    """Validate the STDIN cut list loudly and return frame ranges as
    [(start_frame, end_frame, cut_start_seconds, cut_end_seconds), ...] (Fraction).

    allow_empty is True on the per-story path (a user may mark stories without cutting)."""
    if not isinstance(cuts_raw, list):
        raise ManifestError("cuts must be a JSON array")
    if not cuts_raw and not allow_empty:
        raise ManifestError("empty cuts list: nothing to export (a caller must send at least one cut)")
    cuts = []
    for i, c in enumerate(cuts_raw):
        if not isinstance(c, dict):
            raise ManifestError(f"cut #{i} is not an object with startFrame/endFrame")
        sf = c.get('startFrame')
        ef = c.get('endFrame')
        if not isinstance(sf, int) or isinstance(sf, bool) or not isinstance(ef, int) or isinstance(ef, bool):
            raise ManifestError(f"cut #{i} startFrame/endFrame must be integers, got {sf!r}/{ef!r}")
        if sf < 0:
            raise ManifestError(f"cut #{i} startFrame {sf} is negative")
        if sf >= ef:
            raise ManifestError(f"cut #{i} is empty or reversed: startFrame {sf} >= endFrame {ef}")
        cuts.append((sf, ef, sf * frame_seconds, ef * frame_seconds))
    for i in range(1, len(cuts)):
        prev = cuts[i - 1]
        cur = cuts[i]
        if cur[0] < prev[1]:
            raise ManifestError(
                f"cuts must be sorted ascending and non-overlapping: cut #{i} startFrame "
                f"{cur[0]} precedes cut #{i - 1} endFrame {prev[1]}")
    for (sf, ef, cs, ce) in cuts:
        if ce > total_declared:
            raise ManifestError(
                f"cut [frames {sf}..{ef}) ends at {float(ce)}s which is beyond the "
                f"concatenated timeline duration {float(total_declared)}s")
    return cuts


def _inputs_frame_aligned(parts, frame_seconds):
    """True iff every offset/start/duration in every spine subtree is frame-aligned.
    When True we assert the same of every computed value; when False the source itself
    was not frame-quantized, so we pass computed values through without that assertion."""
    for part in parts:
        for el in part['spine'].iter():
            for attr in ('offset', 'start', 'duration'):
                v = el.get(attr)
                if v is None:
                    continue
                try:
                    fr = parse_rational(v, attr)
                except ManifestError:
                    return False
                if not _is_frame_aligned(fr, frame_seconds):
                    return False
    return True


def apply_cuts(tree, entry_name, cuts_raw):
    """Mutate `tree` in place: apply cuts to every part, ripple, update sequence
    durations. Returns (new_total_declared: Fraction, cuts_applied: int)."""
    root = tree.getroot()
    parts, frame_seconds, total_declared = _collect_parts(root, entry_name)
    cuts = _validate_cuts(cuts_raw, frame_seconds, total_declared)
    check_align = _inputs_frame_aligned(parts, frame_seconds)
    if not check_align:
        print(f"[editor_export] {entry_name}: source spine values are not all frame-aligned; "
              "frame-alignment assertions on computed values are disabled", file=sys.stderr)

    global_cuts = [(cs, ce) for (_sf, _ef, cs, ce) in cuts]
    base = Fraction(0)
    new_total = Fraction(0)
    for part in parts:
        declared = part['declared']
        part_end = base + declared
        # Map global cuts into this part's LOCAL coordinates (subtract base, clamp to
        # [0, declared)). A cut spanning a part boundary is clamped on each side, so it
        # is applied to both parts. Sorted+non-overlapping globally -> same locally.
        local_cuts = []
        for (cs, ce) in global_cuts:
            s = cs - base
            e = ce - base
            if s < 0:
                s = Fraction(0)
            if e > declared:
                e = declared
            if s < e:
                local_cuts.append((s, e))
        removed = sum((e - s for (s, e) in local_cuts), Fraction(0))
        new_declared = declared - removed

        spine = part['spine']
        ripple = make_ripple(local_cuts)
        context = f"{entry_name}: project {part['name']!r}"
        original_children = list(spine)
        for ch in original_children:
            spine.remove(ch)
        for ch in original_children:
            if ch.tag not in TIMELINE_TAGS:
                raise ManifestError(
                    f"{context}: unexpected non-timeline spine child <{ch.tag}>; cannot ripple it safely")
            for piece in split_spine_element(ch, local_cuts, ripple, frame_seconds, check_align, context):
                spine.append(piece)

        _set_time(part['sequence'], 'duration', new_declared, frame_seconds, check_align,
                  f"{context} sequence duration")
        base = part_end
        new_total += new_declared

    return new_total, len(cuts)


# ---------------------------------------------------------------------------
# Per-story export (split the timeline into one <project> per marked story)
# ---------------------------------------------------------------------------
#
# A story export is the INVERSE of a cut export: instead of removing the cuts and
# keeping everything else, we KEEP only a story's resolved regions (minus the user's
# cuts) and drop everything else, then collapse the survivors to a single continuous
# timeline rebased to 0. It reuses the exact same spine surgery (split_spine_element /
# _trim_children) — we just feed it the COMPLEMENT of the story's kept intervals as the
# per-part "cuts", and supply a GLOBAL collapse ripple (continuous across parts) instead
# of make_ripple's per-part one. Within any single kept interval the collapse map is a
# uniform shift t - const — the very property _trim_children already relies on — so a
# survivor piece's anchored children stay internally consistent wherever the piece lands.

def _complement(intervals, lo, hi):
    """Gaps of [lo, hi) not covered by `intervals` (sorted ascending, disjoint, already
    clamped inside [lo, hi)). Returns sorted disjoint (s, e) — the per-part cut list that
    makes split_spine_element keep exactly `intervals`."""
    gaps = []
    cur = lo
    for s, e in intervals:
        if s > cur:
            gaps.append((cur, s))
        cur = e
    if cur < hi:
        gaps.append((cur, hi))
    return gaps


def _snap_to_frame(sec, frame_seconds, context):
    """Snap a frontend float-seconds boundary to its exact frame time. The frontend already
    quantizes story boundaries to frames, so round() recovers the integer frame index
    exactly; a value more than half a frame off is a contract violation -> raise loud."""
    if not isinstance(sec, (int, float)) or isinstance(sec, bool):
        raise ManifestError(f"{context}: expected a number of seconds, got {sec!r}")
    idx = round(sec / float(frame_seconds))
    if idx < 0:
        raise ManifestError(f"{context}: negative time {sec}s")
    exact = idx * frame_seconds
    drift = abs(float(exact) - float(sec))
    if drift > float(frame_seconds) / 2:
        raise ManifestError(
            f"{context}: {sec}s is not on a frame boundary (nearest frame {idx} = "
            f"{float(exact)}s, off by {drift}s > half a frame)")
    return idx, exact


def _slugify(title, number):
    """Kebab-case slug for filenames / the CS round-trip key. Falls back to the story number
    when the title has no slug-able characters."""
    out = []
    prev_dash = False
    for ch in (title or '').lower():
        if ch.isalnum():
            out.append(ch)
            prev_dash = False
        elif not prev_dash:
            out.append('-')
            prev_dash = True
    slug = ''.join(out).strip('-')
    return slug or f"story-{number}"


def _make_collapse(kept):
    """Build the global collapse ripple for a story from its kept intervals (sorted disjoint
    Fraction seconds). collapse(t) maps a KEPT global time to its position on the story's
    0-based collapsed timeline; total is the collapsed duration. A t not inside any kept
    interval is an internal inconsistency (survivor starts always are) -> raise."""
    cum = []
    acc = Fraction(0)
    for (s, e) in kept:
        cum.append(acc)
        acc += (e - s)
    total = acc

    def collapse(t):
        for i, (s, e) in enumerate(kept):
            if s <= t <= e:
                return cum[i] + (t - s)
        raise ManifestError(
            f"internal error: collapse time {format_time(t)} is not inside any kept region")
    return collapse, total


def _validate_stories(stories_raw, frame_seconds, total_declared):
    """Validate the STDIN stories list loudly. Returns a list of dicts:
    {number:int, title:str, slug:str, kept:[(s,e) Fraction global secs]} in the given order.
    Each story's kept intervals are its resolved regions snapped to frames, clamped to the
    timeline; cuts are subtracted later. Empty region lists are allowed (a fully-overlapped
    story) and yield kept=[]."""
    if not isinstance(stories_raw, list):
        raise ManifestError("stories must be a JSON array")
    if not stories_raw:
        raise ManifestError("empty stories list on the per-story export path")
    total_frames = total_declared / frame_seconds
    if total_frames.denominator != 1:
        raise ManifestError(
            f"internal error: concatenated duration {float(total_declared)}s is not a whole "
            f"number of frames")
    total_frames = int(total_frames)
    out = []
    for i, st in enumerate(stories_raw):
        if not isinstance(st, dict):
            raise ManifestError(f"story #{i} is not an object")
        number = st.get('number')
        if not isinstance(number, int) or isinstance(number, bool):
            raise ManifestError(f"story #{i} has a non-integer 'number': {number!r}")
        title = st.get('title')
        if not isinstance(title, str) or not title.strip():
            raise ManifestError(f"story #{i} (number {number}) has an empty title")
        regions_raw = st.get('regions')
        if not isinstance(regions_raw, list):
            raise ManifestError(f"story {title!r} 'regions' must be an array")
        regions = []
        for r in regions_raw:
            if not isinstance(r, dict):
                raise ManifestError(f"story {title!r} has a non-object region")
            si, s = _snap_to_frame(r.get('start'), frame_seconds, f"story {title!r} region start")
            ei, e = _snap_to_frame(r.get('end'), frame_seconds, f"story {title!r} region end")
            if si >= ei:
                raise ManifestError(f"story {title!r} region is empty or reversed: {si}..{ei} frames")
            if ei > total_frames:
                raise ManifestError(
                    f"story {title!r} region ends at frame {ei} beyond the timeline's "
                    f"{total_frames} frames")
            regions.append((s, e))
        regions.sort()
        for k in range(1, len(regions)):
            if regions[k][0] < regions[k - 1][1]:
                raise ManifestError(
                    f"story {title!r} regions overlap: {float(regions[k][0])}s precedes prior "
                    f"end {float(regions[k - 1][1])}s (resolveStoryRegions must emit disjoint regions)")
        out.append({'number': number, 'title': title.strip(),
                    'slug': _slugify(title, number), 'regions': regions})
    return out


def _build_story_project(story, kept, collapse, total, parts, frame_seconds, check_align, seq_template, entry_name):
    """Build one <project> for a story from its kept global intervals, using the story's
    pre-built collapse ripple. Returns the <project> Element, or None if it keeps nothing."""
    if not kept:
        return None

    new_children = []
    base = Fraction(0)
    for part in parts:
        declared = part['declared']
        # Kept intervals overlapping this part, mapped to part-LOCAL [0, declared).
        part_kept = []
        for (ks, ke) in kept:
            s = max(ks - base, Fraction(0))
            e = min(ke - base, declared)
            if s < e:
                part_kept.append((s, e))
        if not part_kept:
            base += declared
            continue
        local_cuts = _complement(part_kept, Fraction(0), declared)
        # Capture base by value; ripple maps a part-local survivor start to global collapsed.
        ripple = (lambda b: (lambda s: collapse(b + s)))(base)
        context = f"{entry_name}: story {story['title']!r} @ part {part['name']!r}"
        for ch in list(part['spine']):
            if ch.tag not in TIMELINE_TAGS:
                raise ManifestError(
                    f"{context}: unexpected non-timeline spine child <{ch.tag}>; cannot split it safely")
            for piece in split_spine_element(ch, local_cuts, ripple, frame_seconds, check_align, context):
                new_children.append(piece)
        base += declared

    # Collapsed pieces must be pairwise non-overlapping and ascending (parts and pieces are in
    # ascending order and collapse is monotone). HOLES are expected and legitimate: within a
    # kept region that spans a part seam, the earlier part's spine ends before its DECLARED
    # length (trailing padding), so the collapsed timeline has an empty stretch there. A bare
    # offset-hole in a spine is invalid FCPX, so every leading/internal hole is filled with an
    # explicit <gap> (the same element the generators use for compound headroom). Trailing
    # padding (last content end < total) stays implicit — a sequence whose declared duration
    # exceeds its last clip is valid and is exactly the source parts' own convention.
    project = ET.Element('project', {'name': story['title']})
    sequence = ET.SubElement(project, 'sequence')
    for k, v in seq_template.attrib.items():
        sequence.set(k, v)          # inherit format/tcStart/tcFormat/audioLayout/audioRate
    sequence.set('duration', format_time(total))
    spine = ET.SubElement(sequence, 'spine')

    cursor = Fraction(0)
    for piece in new_children:
        off = parse_rational(piece.get('offset'), 'collapsed piece offset')
        dur = parse_rational(piece.get('duration'), 'collapsed piece duration')
        if off < cursor:
            raise ManifestError(
                f"{entry_name}: story {story['title']!r}: collapsed pieces overlap "
                f"(offset {format_time(off)} < previous end {format_time(cursor)})")
        if off > cursor:
            gap = ET.SubElement(spine, 'gap')
            gap.set('name', 'Gap')
            gap.set('offset', format_time(cursor))
            gap.set('duration', format_time(off - cursor))
        spine.append(piece)
        cursor = off + dur
    if cursor > total:
        raise ManifestError(
            f"{entry_name}: story {story['title']!r}: collapsed content ends at "
            f"{format_time(cursor)} beyond the kept total {format_time(total)}")
    return project


# ---------------------------------------------------------------------------
# Per-story transcript export (Content Studio import format)
# ---------------------------------------------------------------------------
# When a <session>_transcript.json sidecar sits next to the zip, each emitted story also
# gets a Content Studio import file. The sidecar's word times (timelineStart/End) live in
# the SAME declared-concatenated timeline as the story regions/cuts, so the very same
# collapse ripple that rebases the FCPXML rebases the words — guaranteeing the split video
# and its transcript stay in lock-step. Format contract: ContentStudio/electron/services/
# metadata/TRANSCRIPT-IMPORT-FORMAT.md (timebase:"story", 0-based, semantic speaker ids).

def _load_transcript_sidecar(zip_path, frame_seconds):
    """Load <session>_transcript.json next to the zip, or None if absent. Fails loud if it
    exists but is malformed or disagrees with the hybrid's frame duration (a real mismatch,
    never silently skipped)."""
    p = Path(zip_path).parent / f"{_session_name(zip_path)}_transcript.json"
    if not p.is_file():
        return None
    try:
        with open(p) as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError) as e:
        raise ManifestError(f"transcript sidecar {p.name}: cannot read/parse: {e}")
    if not isinstance(data.get('tracks'), list) or not data['tracks']:
        raise ManifestError(f"transcript sidecar {p.name}: missing 'tracks'")
    if not isinstance(data.get('words'), list):
        raise ManifestError(f"transcript sidecar {p.name}: missing 'words'")
    fs = data.get('frameSeconds')
    if not isinstance(fs, (int, float)) or abs(float(fs) - float(frame_seconds)) > 1e-9:
        raise ManifestError(
            f"transcript sidecar {p.name}: frameSeconds {fs} disagrees with the hybrid's "
            f"{float(frame_seconds)} — sidecar and project are from different sources")
    print(f"[editor_export] transcript sidecar: {p.name} ({len(data['words'])} words)", file=sys.stderr)
    return data


def _speaker_map(tracks):
    """Map sidecar track ids -> (semantic_id, label) for Content Studio. A track whose label
    or filename mentions 'screen' becomes 'screen'; the rest are mic, mic2, mic3... in track
    order. CS infers 'screen' the same way, so these ids round-trip cleanly."""
    out = {}
    mic_n = 0
    for t in tracks:
        blob = f"{t.get('label') or ''} {t.get('file') or ''}".lower()
        if 'screen' in blob:
            out[t['id']] = ('screen', 'Screen audio')
        else:
            mic_n += 1
            out[t['id']] = ('mic', 'Mic') if mic_n == 1 else (f'mic{mic_n}', f'Mic {mic_n}')
    return out


def _build_story_transcript(story, kept, total, sidecar, speaker_map):
    """Build the Content Studio import doc for one story: keep every word whose MIDPOINT lands
    in a kept interval (the sidecar's own cut convention) and rebase its times to the story's
    0-based collapsed timeline by that interval's constant collapse shift."""
    import bisect
    starts = [float(s) for (s, _e) in kept]
    ends = [float(e) for (_s, e) in kept]
    cum = []
    acc = Fraction(0)
    for (s, e) in kept:
        cum.append(acc)
        acc += (e - s)
    shifts = [float(cum[i] - kept[i][0]) for i in range(len(kept))]  # constant per interval
    total_f = float(total)

    words = []
    used = {}
    for w in sidecar['words']:
        ts = w['timelineStart']
        te = w['timelineEnd']
        mid = (ts + te) / 2.0
        i = bisect.bisect_right(starts, mid) - 1
        if i < 0 or mid > ends[i]:
            continue                       # midpoint fell in a cut / outside the story
        sid, lab = speaker_map[w['track']]
        used[sid] = lab
        start = ts + shifts[i]
        end = te + shifts[i]
        if start < 0.0:
            start = 0.0
        if end > total_f:
            end = total_f
        word = {'speaker': sid, 'text': w['text'], 'start': start, 'end': end}
        if 'prob' in w:
            word['confidence'] = w['prob']
        words.append(word)
    words.sort(key=lambda x: (x['start'], x['end']))

    # speakers in track order, only those that actually appear
    speakers = []
    seen = set()
    for _tid, (sid, lab) in speaker_map.items():
        if sid in used and sid not in seen:
            speakers.append({'id': sid, 'label': lab})
            seen.add(sid)

    return {
        'formatVersion': 1,
        'producer': 'AutoCutStudio',
        'sourceSession': sidecar.get('session'),
        'story': {'number': story['number'], 'title': story['title'], 'slug': story['slug'],
                  'startSeconds': float(kept[0][0])},
        'language': 'en',
        'durationSeconds': total_f,
        'timebase': 'story',
        'speakers': speakers,
        'words': words,
    }


def apply_stories(tree, entry_name, cuts_raw, stories_raw, sidecar=None):
    """Mutate `tree` in place: replace the part <project>s under <event> with one <project>
    per story (regions minus cuts, collapsed to 0, named by title, ordered by number).
    Returns a list of per-story result dicts; each carries its Content Studio transcript doc
    under 'transcript' when a sidecar was supplied and the story kept content."""
    root = tree.getroot()
    parts, frame_seconds, total_declared = _collect_parts(root, entry_name)
    cuts = _validate_cuts(cuts_raw, frame_seconds, total_declared, allow_empty=True)
    stories = _validate_stories(stories_raw, frame_seconds, total_declared)
    check_align = _inputs_frame_aligned(parts, frame_seconds)
    if not check_align:
        print(f"[editor_export] {entry_name}: source spine values are not all frame-aligned; "
              "frame-alignment assertions on computed values are disabled", file=sys.stderr)

    global_cuts = [(cs, ce) for (_sf, _ef, cs, ce) in cuts]
    seq_template = parts[0]['sequence']
    speaker_map = _speaker_map(sidecar['tracks']) if sidecar else None

    projects = []
    results = []
    seen_slugs = set()
    for story in stories:
        # kept = this story's regions with the user's cuts removed (both global secs).
        kept = []
        for (rs, re) in story['regions']:
            kept.extend(subtract_cuts(rs, re, global_cuts))
        kept.sort()
        # Slug is assigned even for empty stories so numbering/keys stay stable.
        slug = story['slug']
        if slug in seen_slugs:
            n = 2
            while f"{slug}-{n}" in seen_slugs:
                n += 1
            slug = f"{slug}-{n}"
        seen_slugs.add(slug)
        story = {**story, 'slug': slug}

        if kept:
            collapse, total = _make_collapse(kept)
            project = _build_story_project(
                story, kept, collapse, total, parts, frame_seconds, check_align, seq_template, entry_name)
            projects.append((story['number'], project))
        else:
            total = Fraction(0)
            print(f"[editor_export] story {story['title']!r} keeps no content (fully overlapped "
                  f"or entirely cut) — not emitted", file=sys.stderr)

        result = {
            'number': story['number'], 'title': story['title'], 'slug': slug,
            'durationSeconds': float(total), 'emitted': bool(kept),
        }
        if kept and sidecar is not None:
            result['transcript'] = _build_story_transcript(story, kept, total, sidecar, speaker_map)
        results.append(result)

    if not projects:
        raise ManifestError("no story keeps any content: nothing to export")

    event = root.find('.//event')
    if event is None:
        raise ManifestError(f"{entry_name}: no <event> element to hold story projects")
    for p in event.findall('project'):
        event.remove(p)
    projects.sort(key=lambda np: np[0])   # by story number ascending
    for _num, project in projects:
        event.append(project)

    return results


def export_stories(zip_path, cuts_raw, stories_raw):
    zp = Path(zip_path)
    if not zp.is_file():
        raise ManifestError(f"zip not found: {zip_path}")
    if not zipfile.is_zipfile(zp):
        raise ManifestError(f"not a valid zip file: {zip_path}")

    with zipfile.ZipFile(zp, 'r') as zf:
        entry = _find_master_hybrid_entry(zf, zip_path)
        print(f"[editor_export] master hybrid entry: {entry}", file=sys.stderr)
        with zf.open(entry) as fh:
            try:
                tree = ET.parse(fh)
            except ET.ParseError as e:
                raise ManifestError(f"{entry}: XML parse error: {e}")

    # frame_seconds is needed to validate the sidecar; recover it the same way apply_stories
    # does (cheap — _collect_parts is pure and side-effect-free on the tree).
    _parts, frame_seconds, _td = _collect_parts(tree.getroot(), entry)
    sidecar = _load_transcript_sidecar(zip_path, frame_seconds)

    results = apply_stories(tree, entry, cuts_raw, stories_raw, sidecar)

    out_path = zp.parent / f"{_session_name(zip_path)}_HYBRID_stories.fcpxml"
    if out_path.exists():
        print(f"[editor_export] overwriting existing derived artifact: {out_path}", file=sys.stderr)
    FCPXMLUtils.save_fcpxml(tree, str(out_path))
    emitted = sum(1 for r in results if r['emitted'])
    print(f"[editor_export] wrote {out_path} ({emitted}/{len(results)} stories emitted)", file=sys.stderr)

    # Per-story transcript files (Content Studio import format), grouped in a sibling folder.
    tx_dir = zp.parent / f"{_session_name(zip_path)}_stories_transcripts"
    for r in results:
        doc = r.pop('transcript', None)
        if doc is None:
            continue
        tx_dir.mkdir(exist_ok=True)
        tx_path = tx_dir / f"{r['number']:02d}-{r['slug']}.json"
        tmp = tx_path.with_suffix('.json.tmp')
        with open(tmp, 'w') as fh:
            json.dump(doc, fh, ensure_ascii=False, indent=2)
        tmp.replace(tx_path)
        r['transcriptPath'] = str(tx_path)
        r['wordCount'] = len(doc['words'])
        print(f"[editor_export] wrote transcript {tx_path.name} ({len(doc['words'])} words)", file=sys.stderr)

    return {
        'type': 'story_export_result',
        'path': str(out_path),
        'storiesEmitted': emitted,
        'stories': results,
        'transcriptsDir': str(tx_dir) if any('transcriptPath' in r for r in results) else None,
    }


def export(zip_path, cuts_raw):
    zp = Path(zip_path)
    if not zp.is_file():
        raise ManifestError(f"zip not found: {zip_path}")
    if not zipfile.is_zipfile(zp):
        raise ManifestError(f"not a valid zip file: {zip_path}")

    with zipfile.ZipFile(zp, 'r') as zf:
        entry = _find_master_hybrid_entry(zf, zip_path)
        print(f"[editor_export] master hybrid entry: {entry}", file=sys.stderr)
        with zf.open(entry) as fh:
            try:
                tree = ET.parse(fh)
            except ET.ParseError as e:
                raise ManifestError(f"{entry}: XML parse error: {e}")

    new_total, cuts_applied = apply_cuts(tree, entry, cuts_raw)

    out_path = zp.parent / f"{_session_name(zip_path)}_HYBRID_edited.fcpxml"
    if out_path.exists():
        print(f"[editor_export] overwriting existing derived artifact: {out_path}", file=sys.stderr)
    FCPXMLUtils.save_fcpxml(tree, str(out_path))
    print(f"[editor_export] wrote {out_path} (new duration {float(new_total)}s, "
          f"{cuts_applied} cut(s) applied)", file=sys.stderr)

    return {
        'type': 'export_result',
        'path': str(out_path),
        'cutsApplied': cuts_applied,
        'newDurationSeconds': float(new_total),
    }


def _read_payload_from_stdin():
    """Parse the stdin JSON. Returns (cuts, stories) where stories is None on the plain
    cut-export path and a list on the per-story path."""
    raw = sys.stdin.read()
    if not raw.strip():
        raise ManifestError("no JSON received on stdin (expected {\"cuts\": [...]})")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ManifestError(f"stdin is not valid JSON: {e}")
    if not isinstance(payload, dict) or 'cuts' not in payload:
        raise ManifestError("stdin JSON must be an object with a 'cuts' array")
    stories = payload.get('stories')
    if stories is not None and not isinstance(stories, list):
        raise ManifestError("stdin 'stories', when present, must be an array")
    return payload['cuts'], stories


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Apply ripple cuts to a compounds zip's master hybrid project and export a revised FCPXML.")
    parser.add_argument('--zip', dest='zip_path', required=True,
                        help='Absolute path to the <name>_compounds.zip')
    args = parser.parse_args(argv)

    try:
        cuts_raw, stories_raw = _read_payload_from_stdin()
        if stories_raw:
            result = export_stories(args.zip_path, cuts_raw, stories_raw)
        else:
            result = export(args.zip_path, cuts_raw)
    except ManifestError as e:
        sys.stdout.write(json.dumps({'type': 'error', 'message': str(e)}) + '\n')
        sys.stdout.flush()
        return 1
    except Exception as e:  # unexpected — still fail loud, never emit a partial success
        sys.stdout.write(json.dumps({'type': 'error', 'message': f"{type(e).__name__}: {e}"}) + '\n')
        sys.stdout.flush()
        return 1

    sys.stdout.write(json.dumps(result) + '\n')
    sys.stdout.flush()
    return 0


if __name__ == '__main__':
    sys.exit(main())
