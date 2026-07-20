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


def _validate_cuts(cuts_raw, frame_seconds, total_declared):
    """Validate the STDIN cut list loudly and return frame ranges as
    [(start_frame, end_frame, cut_start_seconds, cut_end_seconds), ...] (Fraction)."""
    if not isinstance(cuts_raw, list):
        raise ManifestError("cuts must be a JSON array")
    if not cuts_raw:
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


def _read_cuts_from_stdin():
    raw = sys.stdin.read()
    if not raw.strip():
        raise ManifestError("no JSON received on stdin (expected {\"cuts\": [...]})")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ManifestError(f"stdin is not valid JSON: {e}")
    if not isinstance(payload, dict) or 'cuts' not in payload:
        raise ManifestError("stdin JSON must be an object with a 'cuts' array")
    return payload['cuts']


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Apply ripple cuts to a compounds zip's master hybrid project and export a revised FCPXML.")
    parser.add_argument('--zip', dest='zip_path', required=True,
                        help='Absolute path to the <name>_compounds.zip')
    args = parser.parse_args(argv)

    try:
        cuts_raw = _read_cuts_from_stdin()
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
