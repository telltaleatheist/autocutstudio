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
#     { "cuts": [ {"startFrame": int, "endFrame": int}, ... ],
#       "sequence": [ {"start": float, "end": float}, ... ]   # OPTIONAL playback order }
#
# 'sequence' is the OPTIONAL reorder: an ordered list of the surviving spans (ORIGINAL
# seconds, the same declared-concatenated time base as cuts and stories[].regions) in the
# order they should PLAY. Absent, the export behaves exactly as it always has (survivors
# play in source order). Present, it must PARTITION the footage the cuts leave behind: the
# spans may divide a survivor run at any frame (a drag snaps to CLIP edges, which have
# nothing to do with where cuts are) and play the pieces in any order, but joined together
# they must cover exactly the survivors — see _validate_sequence for why anything else is
# refused outright.
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
import re
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
# _trim_children) — we just feed it the COMPLEMENT of a kept interval as the per-part
# "cuts", and a ripple that carries that interval to its own output offset instead of
# make_ripple's per-part shift. Within any single kept interval that ripple is a uniform
# shift t - const — the very property _trim_children already relies on — so a survivor
# piece's anchored children stay internally consistent wherever the piece lands.
#
# The unit of work is ONE kept interval (see _placements), not the whole kept set: the
# complement of a SET glues intervals that touch, and split_spine_element would then never
# cut between them — two intervals the user wants in different places would ride out as a
# single piece at the first one's offset. Windowing one interval at a time is what lets a
# reorder split a survivor run at any frame.

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


def _cumulative_offsets(kept, order=None):
    """Collapsed output offset of every kept interval (aligned to `kept`) and the collapsed
    total. Offsets accumulate in PLAYBACK order — `order`, a permutation of `kept`, or source
    order when it is None. This is the ONE place playback order turns into numbers: both the
    spine collapse and the transcript rebasing read it from here, so picture and words cannot
    drift apart under a reorder."""
    cum_of = {}
    acc = Fraction(0)
    for iv in (kept if order is None else order):
        cum_of[iv] = acc
        acc += (iv[1] - iv[0])
    if len(cum_of) != len(kept) or any(iv not in cum_of for iv in kept):
        raise ManifestError(
            "internal error: playback order is not a permutation of the kept intervals "
            f"({len(order or kept)} ordered vs {len(kept)} kept) — a survivor would be "
            "duplicated or lost")
    return [cum_of[iv] for iv in kept], acc


def _placements(kept, order=None):
    """Where each kept interval LANDS: [(s, e, out_offset)] in PLAYBACK order, plus the
    collapsed total. Each entry is one keep-window for _build_story_project, and inside it the
    output map is the uniform shift t -> t - s + out_offset.

    `order` is the same intervals in playback order (a permutation of `kept`); None keeps
    source order. Intervals that are ADJACENT in the source and CONSECUTIVE in playback are
    merged into one window — offsets accumulate in playback order, so their output is
    contiguous too and one window produces exactly the piece two windows would produce
    side by side. That merge is what keeps a non-reordered export identical to what it has
    always emitted, and it stops a reorder from introducing a cut point the order does not
    actually need."""
    cum, total = _cumulative_offsets(kept, order)
    offset_of = dict(zip(kept, cum))
    out = []
    for iv in (kept if order is None else order):
        off = offset_of[iv]
        if out and out[-1][1] == iv[0]:
            out[-1] = (out[-1][0], iv[1], out[-1][2])
        else:
            out.append((iv[0], iv[1], off))
    return out, total


# ---------------------------------------------------------------------------
# Reorder (the OPTIONAL 'sequence' payload field)
# ---------------------------------------------------------------------------
# Double-precision seconds carry ~1e-12 of representation noise at hour-scale times, while
# one frame is ~33ms. A tolerance six orders of magnitude below a frame therefore absorbs
# float noise while still catching a boundary that was never quantized — unlike
# _snap_to_frame's half-a-frame window, which round() can never actually exceed and which
# would silently pull an off-grid boundary onto the nearest frame.
_FRAME_EPSILON = 1e-6


def _exact_frame(sec, frame_seconds, context):
    """Convert an ALREADY frame-quantized float-seconds boundary to its exact frame time.
    Refuses anything off the grid rather than rounding it — a reorder that resizes a span
    by a fraction of a frame would desync picture from the cut list it was derived from."""
    if not isinstance(sec, (int, float)) or isinstance(sec, bool):
        raise ManifestError(f"{context}: expected a number of seconds, got {sec!r}")
    idx = round(sec / float(frame_seconds))
    exact = idx * frame_seconds
    drift = abs(float(exact) - float(sec))
    if drift > _FRAME_EPSILON:
        raise ManifestError(
            f"{context}: {sec}s is not frame-aligned (nearest frame {idx} = {float(exact)}s, "
            f"off by {drift}s; frameDuration is {float(frame_seconds)}s)")
    return idx, exact


def _validate_sequence(sequence_raw, cuts, frame_seconds, total_declared):
    """Validate the playback order loudly. Returns [(s, e) Fraction global secs] in PLAYBACK
    order.

    A reorder's freedom is WHERE footage plays and where it is divided, never WHICH footage
    exists: the spans must PARTITION the survivors of the cuts. They may split a survivor run
    at any frame the user dragged to (clip edges have nothing to do with cut boundaries), but
    joined back together they must cover exactly the complement of the cuts — so a span may
    not overlap another, leave a gap, or reach into cut material. A violation means the
    frontend and the export disagree about what survives, and since a collapsed timeline
    looks perfectly well-formed either way, nothing downstream would catch it. Refuse."""
    if not isinstance(sequence_raw, list):
        raise ManifestError("sequence must be a JSON array of {start, end} spans")
    if not sequence_raw:
        raise ManifestError(
            "empty sequence: a reorder must list every surviving span (omit 'sequence' "
            "entirely to keep source order)")
    spans = []
    for i, sp in enumerate(sequence_raw):
        if not isinstance(sp, dict):
            raise ManifestError(f"sequence span #{i} is not an object with start/end")
        _si, s = _exact_frame(sp.get('start'), frame_seconds, f"sequence span #{i} start")
        _ei, e = _exact_frame(sp.get('end'), frame_seconds, f"sequence span #{i} end")
        if s >= e:
            raise ManifestError(
                f"sequence span #{i} is empty or reversed: start {float(s)}s >= end {float(e)}s")
        if s < 0 or e > total_declared:
            raise ManifestError(
                f"sequence span #{i} [{float(s)}..{float(e)}]s lies outside the concatenated "
                f"timeline [0..{float(total_declared)}]s")
        spans.append((s, e))

    ordered = sorted(spans)
    for i in range(1, len(ordered)):
        if ordered[i][0] < ordered[i - 1][1]:
            raise ManifestError(
                f"sequence spans overlap: a span starts at {float(ordered[i][0])}s, before the "
                f"previous one ends at {float(ordered[i - 1][1])}s — a reorder plays every "
                "surviving frame exactly once")
    survivors = _complement([(cs, ce) for (_sf, _ef, cs, ce) in cuts],
                            Fraction(0), total_declared)
    # Joining touching spans back up must reproduce the survivors exactly. That single
    # comparison catches a gap (footage silently dropped), a span reaching into a cut
    # (footage the user removed reappearing) and any span outside the survivors — while
    # still allowing a run to be divided anywhere, which is the whole point of a reorder.
    if _merge_intervals(ordered) != survivors:
        got = [(float(s), float(e)) for (s, e) in _merge_intervals(ordered)]
        want = [(float(s), float(e)) for (s, e) in survivors]
        raise ManifestError(
            "sequence must partition the footage the cuts leave behind: the spans may divide a "
            "survivor run at any frame and play the pieces in any order, but joined together "
            f"they must cover exactly the survivors. Joined spans are {got}, survivors of the "
            f"cuts are {want}")
    return spans


def _order_kept(kept, spans):
    """Intersect one story's kept intervals with the sequence spans and return the pieces in
    PLAYBACK order. Spans may now divide a survivor run anywhere, so a kept interval can
    STRADDLE two spans — it has to be divided there too, otherwise its far half would ride
    along with the near half wherever that lands.

    The spans partition the survivors and kept ⊆ survivors, so the pieces must account for
    every kept frame; if they don't, the kept intervals and the sequence came from different
    cut lists and we would silently drop footage -> raise."""
    out = []
    for span in spans:
        for iv in kept:
            s = max(iv[0], span[0])
            e = min(iv[1], span[1])
            if s < e:
                out.append((s, e))
    covered = sum((e - s for (s, e) in out), Fraction(0))
    want = sum((e - s for (s, e) in kept), Fraction(0))
    if covered != want:
        raise ManifestError(
            f"internal error: sequence spans cover {float(covered)}s of the kept "
            f"{float(want)}s — kept intervals and sequence disagree about what survives")
    return out


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


def _build_story_project(story, placements, total, parts, frame_seconds, check_align, seq_template, entry_name):
    """Build one <project> for a story from its placements — (start, end, out_offset) keep-
    windows in playback order (see _placements). Returns the <project> Element, or None if it
    keeps nothing.

    ONE window at a time is deliberate. Feeding the whole kept set to _complement at once
    glues windows that touch, and split_spine_element would then never cut between them: two
    windows the order wants in different places would leave as a single piece carrying only
    the first one's offset. Per window, the map is the uniform shift t -> t - ks + out_offset,
    which is exactly what _trim_children's anchored-child arithmetic assumes."""
    if not placements:
        return None

    new_children = []
    for (ks, ke, out_offset) in placements:
        base = Fraction(0)
        for part in parts:
            declared = part['declared']
            # This window's overlap with this part, in part-LOCAL [0, declared).
            s = max(ks - base, Fraction(0))
            e = min(ke - base, declared)
            if s < e:
                local_cuts = _complement([(s, e)], Fraction(0), declared)
                # A part-local t is global base + t, so the window's uniform output shift is
                # out_offset + base - ks. Bind it by value: base moves under the closure.
                ripple = (lambda sh: (lambda t: t + sh))(out_offset + base - ks)
                context = f"{entry_name}: story {story['title']!r} @ part {part['name']!r}"
                for ch in list(part['spine']):
                    if ch.tag not in TIMELINE_TAGS:
                        raise ManifestError(
                            f"{context}: unexpected non-timeline spine child <{ch.tag}>; "
                            f"cannot split it safely")
                    for piece in split_spine_element(ch, local_cuts, ripple, frame_seconds,
                                                     check_align, context):
                        new_children.append(piece)
            base += declared

    # Collapsed pieces must be pairwise non-overlapping (the windows partition the kept
    # footage and each lands in its own stretch of output). HOLES are expected and legitimate:
    # within a
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

    # Pieces come out window by window in PLAYBACK order, and a window's output offset is the
    # summed length of the windows before it — so they already ascend, reorder or not, and
    # this sort is a no-op today. It stays because the gap-filling loop below can only fill
    # holes and detect overlap correctly on an ascending list: that must be guaranteed here,
    # not inherited from the emission order of the loop above.
    new_children.sort(key=lambda el: parse_rational(el.get('offset'), 'collapsed piece offset'))

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


def _build_story_transcript(story, kept, total, sidecar, speaker_map, order=None):
    """Build the Content Studio import doc for one story: keep every word whose MIDPOINT lands
    in a kept interval (the sidecar's own cut convention) and rebase its times to the story's
    0-based collapsed timeline by that interval's constant collapse shift. `order` carries the
    reorder: the shifts come from the same cumulative offsets the spine uses, and the final
    sort by rebased start puts the words in the order the picture will actually play."""
    import bisect
    starts = [float(s) for (s, _e) in kept]
    ends = [float(e) for (_s, e) in kept]
    cum, _acc = _cumulative_offsets(kept, order)
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


def _dedup_slug(slug, seen):
    """Make `slug` unique against `seen` (mutated) by appending -2, -3, ..."""
    if slug in seen:
        n = 2
        while f"{slug}-{n}" in seen:
            n += 1
        slug = f"{slug}-{n}"
    seen.add(slug)
    return slug


def _merge_intervals(intervals):
    """Merge sorted-or-not (s, e) Fraction intervals into a sorted disjoint list."""
    out = []
    for (s, e) in sorted(intervals):
        if out and s <= out[-1][1]:
            if e > out[-1][1]:
                out[-1] = (out[-1][0], e)
        else:
            out.append((s, e))
    return out


def _story_kepts(stories, global_cuts):
    """Per validated story: kept global intervals = its regions minus the cuts. Returns
    [(story_with_unique_slug, kept)] preserving order."""
    seen_slugs = set()
    out = []
    for story in stories:
        kept = []
        for (rs, re) in story['regions']:
            kept.extend(subtract_cuts(rs, re, global_cuts))
        kept.sort()
        out.append(({**story, 'slug': _dedup_slug(story['slug'], seen_slugs)}, kept))
    return out


def apply_stories(tree, entry_name, cuts_raw, stories_raw, sequence_raw=None):
    """Mutate `tree` in place: replace the part <project>s under <event> with one <project>
    per story (regions minus cuts, collapsed to 0, named by title, ordered by number), PLUS
    a final "Scrap" project holding every stretch of the timeline no story claimed (minus
    cuts) — so nothing the user didn't explicitly cut is lost. Returns per-story result
    dicts (Scrap included, flagged 'scrap').

    With a `sequence`, each story's own content plays in the sequence's RELATIVE order: the
    reorder is a property of the timeline, so it must survive the split into stories."""
    root = tree.getroot()
    parts, frame_seconds, total_declared = _collect_parts(root, entry_name)
    cuts = _validate_cuts(cuts_raw, frame_seconds, total_declared, allow_empty=True)
    stories = _validate_stories(stories_raw, frame_seconds, total_declared)
    spans = (None if sequence_raw is None
             else _validate_sequence(sequence_raw, cuts, frame_seconds, total_declared))
    check_align = _inputs_frame_aligned(parts, frame_seconds)
    if not check_align:
        print(f"[editor_export] {entry_name}: source spine values are not all frame-aligned; "
              "frame-alignment assertions on computed values are disabled", file=sys.stderr)

    global_cuts = [(cs, ce) for (_sf, _ef, cs, ce) in cuts]
    seq_template = parts[0]['sequence']

    # Scrap = the timeline minus the union of every story's claimed regions, minus cuts.
    # Ordered LAST (number = max story number + 1).
    claimed = _merge_intervals([r for st in stories for r in st['regions']])
    scrap_regions = _complement(claimed, Fraction(0), total_declared)
    scrap_number = max(st['number'] for st in stories) + 1
    with_kepts = _story_kepts(stories, global_cuts)
    scrap_kept = []
    for (rs, re) in scrap_regions:
        scrap_kept.extend(subtract_cuts(rs, re, global_cuts))
    scrap_kept.sort()
    if scrap_kept:
        with_kepts.append((
            {'number': scrap_number, 'title': 'Scrap', 'slug': 'scrap', 'scrap': True},
            scrap_kept))
    else:
        print("[editor_export] no unclaimed content — Scrap project omitted", file=sys.stderr)

    projects = []
    results = []
    for story, kept in with_kepts:
        if kept:
            # The sequence may divide a kept interval, so ordering it can produce MORE
            # intervals than the story had; the divided set is what gets placed.
            order = _order_kept(kept, spans) if spans else None
            placements, total = _placements(sorted(order) if order else kept, order)
            project = _build_story_project(
                story, placements, total, parts, frame_seconds, check_align, seq_template, entry_name)
            projects.append((story['number'], project))
        else:
            total = Fraction(0)
            print(f"[editor_export] story {story['title']!r} keeps no content (fully overlapped "
                  f"or entirely cut) — not emitted", file=sys.stderr)
        results.append({
            'number': story['number'], 'title': story['title'], 'slug': story['slug'],
            'durationSeconds': float(total), 'emitted': bool(kept),
            'scrap': bool(story.get('scrap')),
        })

    if not projects:
        raise ManifestError("no story keeps any content: nothing to export")

    event = root.find('.//event')
    if event is None:
        raise ManifestError(f"{entry_name}: no <event> element to hold story projects")
    for p in event.findall('project'):
        event.remove(p)
    projects.sort(key=lambda np: np[0])   # by story number ascending; Scrap last
    for _num, project in projects:
        event.append(project)

    return results


def _merged_project_name(parts):
    """Name for the single reordered project. It replaces the N part projects, so it cannot
    honestly carry any one part's name; the generators name parts '<session> dc part K', so
    strip that suffix — otherwise a reordered whole-session timeline shows up in FCP labelled
    'part 1'. A name that doesn't match the convention is used as-is."""
    name = parts[0]['name']
    m = re.match(r'^(.*?)\s+part\s+\d+$', name, re.IGNORECASE)
    return m.group(1) if (m and len(parts) > 1) else name


def apply_sequence(tree, entry_name, cuts_raw, sequence_raw):
    """Mutate `tree` in place for the REORDERED master export: replace the part <project>s
    with ONE collapsed project whose spine plays the survivors in `sequence` order. Returns
    (new_total: Fraction, cuts_applied: int).

    apply_cuts cannot do this: it ripples each part in place, so survivors can only ever move
    left within their own part. The story machinery already places an arbitrary set of kept
    intervals at arbitrary collapsed offsets, so a reorder is just that machinery driven by a
    single 'story' that covers every survivor, with the playback order handed to the collapse
    map."""
    root = tree.getroot()
    parts, frame_seconds, total_declared = _collect_parts(root, entry_name)
    # A pure reorder with no cuts is a real edit, so the empty-cuts refusal (which exists to
    # reject a no-op cut export) must not fire here: the sequence itself is the edit.
    cuts = _validate_cuts(cuts_raw, frame_seconds, total_declared, allow_empty=True)
    order = _validate_sequence(sequence_raw, cuts, frame_seconds, total_declared)
    check_align = _inputs_frame_aligned(parts, frame_seconds)
    if not check_align:
        print(f"[editor_export] {entry_name}: source spine values are not all frame-aligned; "
              "frame-alignment assertions on computed values are disabled", file=sys.stderr)

    placements, total = _placements(sorted(order), order)
    pseudo = {'number': 0, 'title': _merged_project_name(parts), 'slug': 'sequence'}
    project = _build_story_project(pseudo, placements, total, parts, frame_seconds,
                                   check_align, parts[0]['sequence'], entry_name)
    if project is None:
        raise ManifestError("sequence keeps no content: nothing to export")

    event = root.find('.//event')
    if event is None:
        raise ManifestError(f"{entry_name}: no <event> element to hold the reordered project")
    for p in event.findall('project'):
        event.remove(p)
    event.append(project)
    return total, len(cuts)


def _parse_master_tree(zip_path):
    """Open the zip, locate the master hybrid entry, and parse it. Shared by all exports."""
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
    return zp, entry, tree


def export_stories(zip_path, cuts_raw, stories_raw, sequence_raw=None):
    """Master FCPXML split by stories: one <project> per story + a Scrap project of the
    unclaimed remainder. Writes ONLY the fcpxml (transcripts are a separate export)."""
    zp, entry, tree = _parse_master_tree(zip_path)
    results = apply_stories(tree, entry, cuts_raw, stories_raw, sequence_raw)

    # Land the story projects in their OWN event, distinctly named. FCP merges imports into
    # an existing same-named event, so keeping the generators' 'Auto-Editor Media Group'
    # name would drop the stories next to previously imported part-projects — confusing.
    event = tree.getroot().find('.//event')
    event.set('name', f"{_session_name(zip_path)} Stories")

    # ONE consolidated edited artifact for the session (same name as the cuts-only path):
    # with stories it holds the story projects + Scrap; without, the cut parts. The
    # distinctly named event (above) keeps FCP imports from blurring into older ones.
    out_path = zp.parent / f"{_session_name(zip_path)} master edited.fcpxml"
    if out_path.exists():
        print(f"[editor_export] overwriting existing derived artifact: {out_path}", file=sys.stderr)
    FCPXMLUtils.save_fcpxml(tree, str(out_path))
    emitted = sum(1 for r in results if r['emitted'])
    print(f"[editor_export] wrote {out_path} ({emitted}/{len(results)} projects emitted)", file=sys.stderr)

    return {
        'type': 'story_export_result',
        'path': str(out_path),
        'storiesEmitted': emitted,
        'stories': results,
    }


def export_transcripts(zip_path, cuts_raw, stories_raw, sequence_raw=None):
    """Per-story Content Studio transcript files ONLY (no fcpxml). The transcript sidecar is
    REQUIRED — exporting transcripts without one is a caller error, not a silent no-op."""
    zp, entry, tree = _parse_master_tree(zip_path)
    _parts, frame_seconds, total_declared = _collect_parts(tree.getroot(), entry)
    sidecar = _load_transcript_sidecar(zip_path, frame_seconds)
    if sidecar is None:
        raise ManifestError(
            f"no transcript sidecar ({_session_name(zip_path)}_transcript.json) next to the zip — "
            "transcribe the session before exporting story transcripts")
    speaker_map = _speaker_map(sidecar['tracks'])

    cuts = _validate_cuts(cuts_raw, frame_seconds, total_declared, allow_empty=True)
    stories = _validate_stories(stories_raw, frame_seconds, total_declared)
    # The transcript must be rebased by the SAME order the fcpxml uses, or the words would
    # describe a timeline that no longer exists.
    spans = (None if sequence_raw is None
             else _validate_sequence(sequence_raw, cuts, frame_seconds, total_declared))
    global_cuts = [(cs, ce) for (_sf, _ef, cs, ce) in cuts]

    tx_dir = zp.parent / f"{_session_name(zip_path)}_stories_transcripts"
    results = []
    wrote = 0
    for story, kept in _story_kepts(stories, global_cuts):
        result = {'number': story['number'], 'title': story['title'], 'slug': story['slug'],
                  'emitted': bool(kept)}
        if kept:
            # Same division as the fcpxml: a kept interval cut by a span boundary becomes two,
            # each rebased by its own shift, so the words follow the picture across the seam.
            order = _order_kept(kept, spans) if spans else None
            divided = sorted(order) if order else kept
            _cum, total = _cumulative_offsets(divided, order)
            doc = _build_story_transcript(story, divided, total, sidecar, speaker_map, order)
            tx_dir.mkdir(exist_ok=True)
            tx_path = tx_dir / f"{story['number']:02d}-{story['slug']}.json"
            tmp = tx_path.with_suffix('.json.tmp')
            with open(tmp, 'w') as fh:
                json.dump(doc, fh, ensure_ascii=False, indent=2)
            tmp.replace(tx_path)
            result['transcriptPath'] = str(tx_path)
            result['wordCount'] = len(doc['words'])
            result['durationSeconds'] = float(total)
            wrote += 1
            print(f"[editor_export] wrote transcript {tx_path.name} ({len(doc['words'])} words)",
                  file=sys.stderr)
        else:
            print(f"[editor_export] story {story['title']!r} keeps no content — no transcript",
                  file=sys.stderr)
        results.append(result)

    if wrote == 0:
        raise ManifestError("no story keeps any content: nothing to export")

    return {
        'type': 'story_export_result',
        'path': str(tx_dir),
        'storiesEmitted': wrote,
        'stories': results,
        'transcriptsDir': str(tx_dir),
    }


def export(zip_path, cuts_raw, sequence_raw=None):
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

    # No sequence -> the historical in-place ripple, untouched. A sequence needs the survivors
    # placed at arbitrary offsets, which only the collapse path can do.
    if sequence_raw is None:
        new_total, cuts_applied = apply_cuts(tree, entry, cuts_raw)
    else:
        new_total, cuts_applied = apply_sequence(tree, entry, cuts_raw, sequence_raw)

    out_path = zp.parent / f"{_session_name(zip_path)} master edited.fcpxml"
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
    """Parse the stdin JSON. Returns (cuts, stories, output, sequence). stories is None on the
    plain cut-export path; when present, 'output' must name what to produce ('fcpxml' — the
    story-split master project, or 'transcripts' — Content Studio files only). Requiring the
    caller to say which (no default) keeps the contract unambiguous.

    'sequence' is optional and stays None when absent — that None is what preserves the
    historical export path byte for byte for every caller that never sends one."""
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
    output = payload.get('output')
    sequence = payload.get('sequence')
    if stories is not None and not isinstance(stories, list):
        raise ManifestError("stdin 'stories', when present, must be an array")
    if sequence is not None and not isinstance(sequence, list):
        raise ManifestError("stdin 'sequence', when present, must be an array of {start, end}")
    if stories:
        if output not in ('fcpxml', 'transcripts'):
            raise ManifestError(
                "with 'stories' present, 'output' must be 'fcpxml' or 'transcripts' "
                f"(got {output!r})")
    elif output is not None:
        raise ManifestError("'output' is only meaningful together with a 'stories' array")
    return payload['cuts'], stories, output, sequence


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Apply ripple cuts to a compounds zip's master hybrid project and export a revised FCPXML.")
    parser.add_argument('--zip', dest='zip_path', required=True,
                        help='Absolute path to the <name>_compounds.zip')
    args = parser.parse_args(argv)

    try:
        cuts_raw, stories_raw, output, sequence_raw = _read_payload_from_stdin()
        if stories_raw and output == 'transcripts':
            result = export_transcripts(args.zip_path, cuts_raw, stories_raw, sequence_raw)
        elif stories_raw:
            result = export_stories(args.zip_path, cuts_raw, stories_raw, sequence_raw)
        else:
            result = export(args.zip_path, cuts_raw, sequence_raw)
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
