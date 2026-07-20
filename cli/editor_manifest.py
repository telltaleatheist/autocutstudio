#!/usr/bin/env python3
# cli/editor_manifest.py
#
# Timeline Editor v1 — manifest builder (Python half of the "timeline editor" feature).
#
# Reads a session's "<name>_compounds.zip", locates the MASTER HYBRID project FCPXML
# inside it, flattens the compound-clip structure down to a flat list of timeline
# segments (each pointing at a real media file with a source in-point), and emits a
# single JSON line describing the whole timeline.
#
# v1 OUTPUT SHAPE (product decision): exactly TWO tracks, both referencing the session
# MASTER recording — "video" (the master's flattened video segments) and "audio" (the
# same segments; the master file's embedded audio IS the master mix). The full layered
# flattening below is the internal mechanism that finds those segments and validates
# the timeline; every other layer (cams, backgrounds, GS/SSB internals, mic/screen
# audio lanes) is traversed, validated, and then dropped from the output.
#
# Invocation:
#     python cli/editor_manifest.py --zip /abs/path/<name>_compounds.zip
#
# Output (stdout, exactly one line):
#     success: {"type":"manifest_result","manifest":{...}}
#     failure: {"type":"error","message":"..."}  + exit code 1
# All diagnostics go to stderr only. stdout carries the one JSON line and nothing else.
#
# DOCTRINE (from CLAUDE.md + project practice): numbers are sacred. There are NO silent
# fallbacks here — every missing/ambiguous input raises with a message naming exactly
# what was wrong. No default is ever substituted for real data. The compound-clip
# structure is fully consumed here and never surfaces in the manifest.

import argparse
import json
import sys
import zipfile
from fractions import Fraction
from pathlib import Path
from urllib.parse import unquote, urlparse
import xml.etree.ElementTree as ET


class ManifestError(Exception):
    """A loud, user-facing failure. Its message is emitted verbatim in the error JSON."""


# ---------------------------------------------------------------------------
# Rational time parsing
# ---------------------------------------------------------------------------
# Semantics match core/xml_utils.py FCPXMLUtils.parse_time exactly (strip trailing
# 's', then "N/D" -> numerator/denominator, else a bare integer over 1). parse_time
# returns an (int, int) tuple; we need EXACT rational arithmetic when composing many
# nested offsets/starts, so we return a fractions.Fraction instead of a float-returning
# helper (a float would accumulate rounding across the compound nesting). Floats are
# produced only at JSON emission.
def parse_rational(time_str, what):
    if time_str is None:
        raise ManifestError(f"missing required time value for {what}")
    t = time_str.strip()
    if t == '':
        raise ManifestError(f"empty time value for {what}")
    if t.endswith('s'):
        t = t[:-1]
    try:
        if '/' in t:
            num_s, den_s = t.split('/')
            return Fraction(int(num_s), int(den_s))
        return Fraction(int(t), 1)
    except (ValueError, ZeroDivisionError) as e:
        raise ManifestError(f"unparseable time value {time_str!r} for {what}: {e}")


# Timeline items we descend into or emit. Anything else (adjust-volume, timeMap,
# audio-channel-source, filter-audio, keyword, data, param, ...) is not a timeline
# element and is skipped structurally.
TIMELINE_TAGS = frozenset({'ref-clip', 'clip', 'asset-clip', 'video', 'audio', 'gap'})


class ManifestBuilder:
    def __init__(self, master_tree, master_entry_name):
        self.root = master_tree.getroot()
        self.entry_name = master_entry_name
        self.formats = {}   # id -> <format> element
        self.assets = {}    # id -> <asset> element
        self.media = {}     # id -> <media> (compound) element
        self._index_resources()

        # Accumulated flattened leaves (before track assignment).
        # Each: dict(kind, timeline_start, timeline_end, source_start, file, label)
        self.leaves = []
        # All referenced media file paths -> whether they exist (deferred existence check).
        self.referenced_files = {}

    # -- resources -----------------------------------------------------------
    def _index_resources(self):
        resources = self.root.find('resources')
        if resources is None:
            raise ManifestError(f"{self.entry_name}: no <resources> element in master hybrid project")
        for el in resources:
            rid = el.get('id')
            if not rid:
                continue
            if el.tag == 'format':
                self.formats[rid] = el
            elif el.tag == 'asset':
                self.assets[rid] = el
            elif el.tag == 'media':
                self.media[rid] = el

    def _frame_seconds(self, format_id, context):
        if not format_id:
            raise ManifestError(f"{context}: sequence has no 'format' attribute; cannot derive frame duration")
        fmt = self.formats.get(format_id)
        if fmt is None:
            raise ManifestError(f"{context}: format {format_id!r} referenced but not defined in <resources>")
        fd = fmt.get('frameDuration')
        if not fd:
            raise ManifestError(
                f"{context}: format {format_id!r} has no frameDuration; frame duration cannot be derived")
        return parse_rational(fd, f"frameDuration of format {format_id!r}")

    # -- asset -> file path --------------------------------------------------
    def _asset_file(self, asset_id, context):
        asset = self.assets.get(asset_id)
        if asset is None:
            raise ManifestError(f"{context}: asset {asset_id!r} referenced but not defined in <resources>")
        media_rep = asset.find('media-rep')
        if media_rep is None:
            raise ManifestError(f"{context}: asset {asset_id!r} has no <media-rep>; no media file to reference")
        src = media_rep.get('src')
        if not src:
            raise ManifestError(f"{context}: asset {asset_id!r} media-rep has no 'src'")
        if not src.startswith('file://'):
            raise ManifestError(f"{context}: asset {asset_id!r} media-rep src is not a file:// URL: {src!r}")
        # file://<encoded-absolute-path>. Decode exactly once (mirrors the single
        # quote() the generator applied in core/xml_utils.create_asset_element).
        parsed = urlparse(src)
        path = unquote(parsed.path)
        if not path:
            raise ManifestError(f"{context}: asset {asset_id!r} media-rep src has empty path: {src!r}")
        self.referenced_files.setdefault(path, Path(path).exists())
        name = asset.get('name') or asset_id
        return path, name, asset

    # -- flatten -------------------------------------------------------------
    def flatten(self):
        """Flatten every <project> in the master hybrid file into self.leaves.

        A master hybrid file may contain more than one <project> when the generator
        split a long session into ~1h parts (master_project_generator._split_clips_into_segments).
        Each part's spine is rebased to start at 0, so the parts are contiguous, ordered
        segments of ONE timeline. We concatenate them in document order, offsetting each
        part by the summed *declared* sequence durations of the parts before it. That
        uses only real declared numbers (no substituted defaults) and reduces exactly to
        the single-project case when there is one part.

        Returns the total declared timeline duration (Fraction seconds) and frameSeconds.
        """
        # projects live under library/event/project (real files); findall is defensive.
        projects = self.root.findall('.//project')
        if not projects:
            raise ManifestError(f"{self.entry_name}: no <project> element found in master hybrid file")

        frame_seconds = None
        base = Fraction(0)          # absolute timeline offset for the current part
        total_declared = Fraction(0)
        for pidx, project in enumerate(projects):
            pname = project.get('name') or f"project#{pidx + 1}"
            sequence = project.find('sequence')
            if sequence is None:
                raise ManifestError(f"{self.entry_name}: project {pname!r} has no <sequence>")
            fs = self._frame_seconds(sequence.get('format'), f"{self.entry_name}: project {pname!r}")
            if frame_seconds is None:
                frame_seconds = fs
            elif fs != frame_seconds:
                raise ManifestError(
                    f"{self.entry_name}: project {pname!r} frame duration {float(fs)} disagrees with "
                    f"first project's {float(frame_seconds)}")

            declared = sequence.get('duration')
            if not declared:
                raise ManifestError(f"{self.entry_name}: project {pname!r} sequence has no 'duration'")
            declared_dur = parse_rational(declared, f"sequence duration of project {pname!r}")

            spine = sequence.find('spine')
            if spine is None:
                raise ManifestError(f"{self.entry_name}: project {pname!r} sequence has no <spine>")

            part_leaves_before = len(self.leaves)
            window = (base, base + declared_dur)
            self._process_items(list(spine), A=base, window=window, active_srcenable=None,
                                context=f"project {pname!r}", lanes=())

            # Per-part agreement check: last emitted segment end vs declared part duration.
            part_leaves = self.leaves[part_leaves_before:]
            if part_leaves:
                part_end = max(l['timeline_end'] for l in part_leaves)
                # allow up to one frame of disagreement, error loudly beyond that
                if abs(part_end - (base + declared_dur)) > frame_seconds:
                    raise ManifestError(
                        f"{self.entry_name}: project {pname!r} declared duration "
                        f"{float(base + declared_dur - base)}s disagrees with flattened content end "
                        f"{float(part_end - base)}s by more than one frame")

            base += declared_dur
            total_declared += declared_dur

        return total_declared, frame_seconds

    def _process_items(self, items, A, window, active_srcenable, context, lanes):
        """Process a list of timeline elements sharing the frame (A, window).

        A is the absolute-timeline time corresponding to local time 0 of this frame.
        window is the visible absolute-timeline [start, end) clamped by all ancestors.
        active_srcenable ('video' | 'audio' | 'all' | None) is the srcEnable of the
        nearest enclosing ref-clip and gates which leaf kinds this compound contributes.
        lanes is the structural LAYER KEY prefix: the tuple of lane values (int; spine /
        no-lane = 0) along the composition path down to (not including) these items.
        Each leaf's layer key = lanes + (its own lane,); video segments are grouped
        into tracks by that key.
        """
        win_start, win_end = window
        for el in items:
            if el.tag not in TIMELINE_TAGS:
                continue
            if el.get('enabled') == '0':
                continue  # disabled lane / clip — excluded entirely, subtree and all

            lane_attr = el.get('lane')
            try:
                lane = int(lane_attr) if lane_attr is not None else 0
            except ValueError:
                raise ManifestError(f"{context}: {el.tag} has unparseable lane {lane_attr!r}")

            offset = parse_rational(el.get('offset', '0s'), f"{context}: {el.tag} offset")
            dur_attr = el.get('duration')
            duration = parse_rational(dur_attr, f"{context}: {el.tag} duration")
            start_attr = el.get('start')
            start = parse_rational(start_attr, f"{context}: {el.tag} start") if start_attr is not None else Fraction(0)

            a0 = A + offset
            a1 = a0 + duration
            clip_start = max(a0, win_start)
            clip_end = min(a1, win_end)
            if clip_start >= clip_end:
                continue  # not visible in the current window

            ref = el.get('ref')

            if el.tag == 'ref-clip':
                if not ref or ref not in self.media:
                    raise ManifestError(
                        f"{context}: ref-clip references {ref!r} which is not a compound <media> in resources")
                # Frame of the referenced compound's internal timeline: local time u maps
                # to absolute a = (A + offset - start) + u  (start is the in-point into the
                # compound). Sub-window is this ref-clip's visible span.
                child_A = A + offset - start
                child_window = (clip_start, clip_end)
                my_srcenable = el.get('srcEnable')  # video | audio | all | None
                # (a) the referenced compound's own content
                compound = self.media[ref]
                comp_seq = compound.find('sequence')
                if comp_seq is None:
                    raise ManifestError(f"{context}: compound {ref!r} has no <sequence>")
                comp_spine = comp_seq.find('spine')
                if comp_spine is None:
                    raise ManifestError(f"{context}: compound {ref!r} sequence has no <spine>")
                self._process_items(list(comp_spine), child_A, child_window, my_srcenable,
                                    context=f"{context} > compound {ref!r}",
                                    lanes=lanes + (lane,))
                # (b) this ref-clip's own anchored lane children (nested ref-clips/clips
                # referencing OTHER compounds/assets). They live in the same compound
                # frame positionally but each sets its own srcEnable, so reset the filter.
                anchored = [c for c in el if c.tag in TIMELINE_TAGS]
                if anchored:
                    self._process_items(anchored, child_A, child_window, None,
                                        context=f"{context} > anchored",
                                        lanes=lanes + (lane,))
                continue

            if el.tag == 'gap' or (el.tag == 'clip' and (ref is None or ref not in self.assets)):
                # Structural container: recurse into children in this element's frame.
                child_A = A + offset - start
                child_window = (clip_start, clip_end)
                children = [c for c in el if c.tag in TIMELINE_TAGS]
                self._process_items(children, child_A, child_window, active_srcenable,
                                    context=f"{context} > {el.tag}",
                                    lanes=lanes + (lane,))
                continue

            # Leaf: video/audio/asset-clip (or clip) referencing an ASSET.
            if not ref:
                raise ManifestError(f"{context}: leaf <{el.tag}> has no 'ref' (no media file to resolve)")
            kind = 'video' if el.tag == 'video' else 'audio'
            if active_srcenable == 'video' and kind != 'video':
                continue
            if active_srcenable == 'audio' and kind != 'audio':
                continue

            path, asset_name, _asset = self._asset_file(ref, context)
            # source-file time at the (left-clipped) segment start. Within a leaf, local
            # time == source-file time (v1 is 1:1; any timeMap drift-retime is ignored —
            # its effect is sub-frame over an editor viewer's needs).
            source_start = start + (clip_start - a0)
            label = el.get('name') or asset_name
            self.leaves.append({
                'kind': kind,
                'timeline_start': clip_start,
                'timeline_end': clip_end,
                'source_start': source_start,
                'file': path,
                'label': label,
                'layer': lanes + (lane,),
            })

    # -- track assembly ------------------------------------------------------
    def _identify_master_file(self):
        """Identify the session master recording among all flattened leaf media files.

        Structural, deterministic rule (no sidecar dependency): the distinct media
        file whose filename stem is exactly 'master' or ends with ' master' — the
        pipeline's naming convention (cli/electron_workflow.py derives session_name
        via stem.replace(' master', '')). Zero or multiple distinct matches is a
        loud error listing every distinct leaf file stem seen.
        """
        stems = {l['file']: Path(l['file']).stem for l in self.leaves}
        matches = sorted({f for f, s in stems.items()
                          if s == 'master' or s.endswith(' master')})
        if len(matches) == 1:
            return matches[0]
        listing = ', '.join(repr(s) for s in sorted(set(stems.values())))
        if not matches:
            raise ManifestError(
                "cannot identify the session master recording: no flattened leaf media "
                "file has a filename stem equal to 'master' or ending in ' master'. "
                f"Distinct leaf file stems seen: {listing}")
        raise ManifestError(
            "cannot identify the session master recording: multiple leaf media files "
            f"match the master naming convention: {matches}. "
            f"Distinct leaf file stems seen: {listing}")

    def build_tracks(self, total_declared, frame_seconds):
        """Validate the full flattened layer structure, then collapse the output to
        exactly TWO tracks referencing the MASTER recording: 'video' (the master
        leaf's flattened video segments) and 'audio' (the same segments — the master
        file's embedded audio is the master mix). All other layers are validated and
        dropped."""
        video = [l for l in self.leaves if l['kind'] == 'video']

        # Internal mechanism, kept intact: group video by structural LAYER KEY (tuple
        # of lane values along the composition path). Simultaneous video on DIFFERENT
        # layers is real; WITHIN one layer, overlap is genuinely malformed — hard error.
        video_groups = {}
        for l in video:
            video_groups.setdefault(l['layer'], []).append(l)
        for key, group in video_groups.items():
            group.sort(key=lambda l: (l['timeline_start'], l['timeline_end']))
            for prev, cur in zip(group, group[1:]):
                if cur['timeline_start'] < prev['timeline_end']:
                    raise ManifestError(
                        f"overlapping enabled video clips on the same layer {key} at "
                        f"{float(cur['timeline_start'])}s: {Path(prev['file']).name} "
                        f"[{float(prev['timeline_start'])}s..{float(prev['timeline_end'])}s] overlaps "
                        f"{Path(cur['file']).name} "
                        f"[{float(cur['timeline_start'])}s..{float(cur['timeline_end'])}s]")

        master_file = self._identify_master_file()
        master_stem = Path(master_file).stem
        master_segs = sorted(
            (l for l in video if l['file'] == master_file),
            key=lambda l: (l['timeline_start'], l['timeline_end']))
        if not master_segs:
            raise ManifestError(
                f"master recording {master_file} has no enabled video segments in the "
                "flattened timeline")

        # Master segments merged across layers must not overlap each other — that
        # would mean multiple simultaneous video layers reference the master.
        for prev, cur in zip(master_segs, master_segs[1:]):
            if cur['timeline_start'] < prev['timeline_end']:
                raise ManifestError(
                    f"master video segments overlap at {float(cur['timeline_start'])}s — "
                    f"the master file {Path(master_file).name} is referenced by multiple "
                    "simultaneous video layers")

        # The master is expected to be present across every cut: an uncovered tail
        # beyond one frame vs the declared sequence duration is a loud error.
        coverage_end = max(l['timeline_end'] for l in master_segs)
        if total_declared - coverage_end > frame_seconds:
            raise ManifestError(
                f"master video coverage ends at {float(coverage_end)}s but the declared "
                f"timeline duration is {float(total_declared)}s — uncovered tail exceeds "
                f"one frame ({float(frame_seconds)}s); the master is expected to span "
                "every cut")

        tracks = [
            {'id': 'video', 'label': 'Master', 'kind': 'video'},
            {'id': 'audio', 'label': 'Master audio', 'kind': 'audio'},
        ]
        segments = []
        for tid in ('video', 'audio'):
            for l in master_segs:
                seg = self._segment(tid, l)
                seg['label'] = master_stem
                segments.append(seg)
        return tracks, segments

    @staticmethod
    def _segment(track_id, leaf):
        return {
            'trackId': track_id,
            'timelineStart': float(leaf['timeline_start']),
            'duration': float(leaf['timeline_end'] - leaf['timeline_start']),
            'file': leaf['file'],
            'sourceStart': float(leaf['source_start']),
            'label': leaf['label'],
        }

    # -- existence check -----------------------------------------------------
    def check_files_exist(self):
        missing = sorted(p for p, exists in self.referenced_files.items() if not exists)
        if missing:
            raise ManifestError(
                "referenced media file(s) not found on disk:\n  " + "\n  ".join(missing))


def _find_master_hybrid_entry(zf, zip_path):
    """Locate the master hybrid project FCPXML entry by the generator's naming convention.

    Naming chain (evidence):
      - master_project_generator._generate_combined_project (output_path is None branch)
        writes "<original_name>_<project_type>.fcpxml"; the master hybrid is produced by
        generate_dc_master_project(...) so project_type == "DC" -> "<name>_DC.fcpxml".
      - cli/electron_workflow.py (~line 1652) then renames that file's "_DC" -> "_HYBRID":
        Path(path).name.replace('_DC', '_HYBRID'), yielding "<name>_HYBRID.fcpxml".
      - cli/electron_workflow.create_xml_zip stores it as "<clean_name>/<filename>", so the
        zip entry is "<clean_name>/<name>_HYBRID.fcpxml".
    The hybrid *compound* files instead end in "_HYBRID_CAM...", "_HYBRID_GS...",
    "_HYBRID_SSB..." (hybrid_compound_generator), and other masters end in "_SOLO.fcpxml",
    "_DC.fcpxml", "_SHORTS.fcpxml" — so an exact "_HYBRID.fcpxml" basename suffix uniquely
    identifies the master hybrid PROJECT. We match on that suffix (no loose globbing).
    """
    candidates = []
    for name in zf.namelist():
        if name.endswith('/'):
            continue
        base = name.rsplit('/', 1)[-1]
        if base.endswith('_HYBRID.fcpxml'):
            candidates.append(name)
    if not candidates:
        others = [n for n in zf.namelist() if not n.endswith('/')]
        raise ManifestError(
            f"no master hybrid project (a '*_HYBRID.fcpxml' entry) found in {zip_path}. "
            f"Zip entries: {others}")
    if len(candidates) > 1:
        raise ManifestError(
            f"multiple '*_HYBRID.fcpxml' entries found in {zip_path}, cannot disambiguate: "
            f"{candidates}")
    return candidates[0]


def _session_name(zip_path):
    stem = Path(zip_path).stem  # <name>_compounds
    if stem.endswith('_compounds'):
        return stem[:-len('_compounds')]
    return stem


def build_manifest(zip_path):
    zp = Path(zip_path)
    if not zp.is_file():
        raise ManifestError(f"zip not found: {zip_path}")
    if not zipfile.is_zipfile(zp):
        raise ManifestError(f"not a valid zip file: {zip_path}")

    with zipfile.ZipFile(zp, 'r') as zf:
        entry = _find_master_hybrid_entry(zf, zip_path)
        print(f"[editor_manifest] master hybrid entry: {entry}", file=sys.stderr)
        with zf.open(entry) as fh:
            try:
                tree = ET.parse(fh)
            except ET.ParseError as e:
                raise ManifestError(f"{entry}: XML parse error: {e}")

    builder = ManifestBuilder(tree, entry)
    total_declared, frame_seconds = builder.flatten()
    builder.check_files_exist()
    tracks, segments = builder.build_tracks(total_declared, frame_seconds)

    # timelineDuration: prefer the declared (summed) sequence duration. Cross-check
    # against the flattened content end; disagree by > one frame -> error stating both.
    content_end = Fraction(0)
    for l in builder.leaves:
        if l['timeline_end'] > content_end:
            content_end = l['timeline_end']
    if builder.leaves and abs(content_end - total_declared) > frame_seconds:
        raise ManifestError(
            f"declared timeline duration {float(total_declared)}s disagrees with flattened "
            f"content end {float(content_end)}s by more than one frame ({float(frame_seconds)}s)")
    timeline_duration = total_declared

    return {
        'schemaVersion': 1,
        'session': _session_name(zip_path),
        'frameSeconds': float(frame_seconds),
        'timelineDuration': float(timeline_duration),
        'tracks': tracks,
        'segments': segments,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="Build a timeline-editor manifest from a compounds zip.")
    parser.add_argument('--zip', dest='zip_path', required=True,
                        help='Absolute path to the <name>_compounds.zip')
    args = parser.parse_args(argv)

    try:
        manifest = build_manifest(args.zip_path)
    except ManifestError as e:
        sys.stdout.write(json.dumps({'type': 'error', 'message': str(e)}) + '\n')
        sys.stdout.flush()
        return 1
    except Exception as e:  # unexpected — still fail loud, never emit a partial manifest
        sys.stdout.write(json.dumps({'type': 'error', 'message': f"{type(e).__name__}: {e}"}) + '\n')
        sys.stdout.flush()
        return 1

    sys.stdout.write(json.dumps({'type': 'manifest_result', 'manifest': manifest}) + '\n')
    sys.stdout.flush()
    return 0


if __name__ == '__main__':
    sys.exit(main())
