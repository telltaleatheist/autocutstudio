#!/usr/bin/env python3
# tests/test_editor_export.py
#
# Tests for cli/editor_export.py. Plain unittest (the repo has no pytest dependency).
# Run:  python tests/test_editor_export.py   (or) python -m unittest tests.test_editor_export
#
# Builds miniature "<name>_compounds.zip" fixtures on disk (same pattern as
# tests/test_editor_manifest.py: hand-written master hybrid FCPXML + real temp media
# files) whose PROJECT spine has several ref-clips (each windowing a slice of the master
# via a shared CAM compound) plus an anchored audio lane child per clip — the same shape
# master_project_generator emits.
#
# THE KILLER PROPERTY TEST (_assert_export_matches_ripple): apply cuts with the export
# code, then run editor_manifest's ManifestBuilder over the EDITED file and assert the
# flattened master segments EXACTLY equal the ORIGINAL manifest's segments with the cut
# ranges removed and ripple applied. Everything is compared in integer FRAME units
# (all fixture times are frame-aligned), so the check is exact, not approximate.

import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from fractions import Fraction
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CLI = REPO_ROOT / 'cli' / 'editor_export.py'
sys.path.insert(0, str(REPO_ROOT))

from cli.editor_manifest import build_manifest, ManifestError  # noqa: E402
from cli.editor_export import (  # noqa: E402
    export, export_stories, apply_cuts, subtract_cuts, make_ripple, format_time,
    MIC_PAD, MIC_MIN_SPEECH, MIC_MIN_WORDS, MIN_MUTE_BLOCK,
    SCREEN_MERGE_GAP, MIC_MERGE_GAP,
)
from core.xml_utils import FCPXMLUtils  # noqa: E402
import xml.etree.ElementTree as ET  # noqa: E402

FRAME = Fraction(1001, 30000)          # 29.97 NDF frame duration
FRAME_F = 1001 / 30000                  # float form for round()


# ---------------------------------------------------------------------------
# Fixture building
# ---------------------------------------------------------------------------
def _t(frames):
    """Frames -> FCPX time string in the /30000 base."""
    return '0s' if frames == 0 else f"{frames * 1001}/30000s"


def make_media_files(dirpath):
    master = Path(dirpath) / 'Session master.mov'
    mix = Path(dirpath) / 'mix.wav'
    for p, data in ((master, 'fake-master-bytes'), (mix, 'fake-audio-bytes')):
        with open(p, 'w') as f:
            f.write(data)
    return str(master), str(mix)


def _clip_xml(o, d, s):
    """A spine ref-clip (srcEnable=video) with an anchored lane -1 audio child, mirroring
    master_project_generator: child offset==start==parent start."""
    start_attr = f' start="{_t(s)}"' if s != 0 else ''
    return (
        f'                    <ref-clip ref="rC" offset="{_t(o)}" name="DC CAM" '
        f'duration="{_t(d)}" srcEnable="video"{start_attr}>\n'
        f'                        <ref-clip ref="rC" lane="-1" offset="{_t(s)}" name="DC CAM audio" '
        f'duration="{_t(d)}" srcEnable="audio"{start_attr}/>\n'
        f'                    </ref-clip>\n'
    )


def master_fcpxml(master_src, mix_src, parts, compound_frames):
    """parts: list of parts; each part is a list of (offset, duration, start) frame specs.
    compound_frames: internal CAM-compound duration (must cover every start+duration)."""
    projects = ''
    for pi, clips in enumerate(parts):
        declared = max(o + d for (o, d, s) in clips)
        spine = ''.join(_clip_xml(o, d, s) for (o, d, s) in clips)
        projects += f'''
            <project name="Session dc part {pi + 1}" uid="PRJ{pi}">
                <sequence format="r1" duration="{_t(declared)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
                    <spine>
{spine}                    </spine>
                </sequence>
            </project>'''
    return f'''<?xml version='1.0' encoding='utf-8'?>
<fcpxml version="1.13">
    <resources>
        <format id="r1" name="FFVideoFormat1080p2997" frameDuration="1001/30000s" width="1920" height="1080" colorSpace="1-1-1 (Rec. 709)" />
        <asset id="a1" name="MASTER" start="0s" duration="{_t(compound_frames)}" format="r1" hasVideo="1" hasAudio="1" audioSources="1" audioChannels="2">
            <media-rep kind="original-media" src="file://{master_src}" />
        </asset>
        <asset id="a2" name="Mix" start="0s" duration="{_t(compound_frames)}" format="r1" hasAudio="1" audioSources="1" audioChannels="2">
            <media-rep kind="original-media" src="file://{mix_src}" />
        </asset>
        <media id="rC" name="Hybrid Cam" uid="CMP" modDate="2026-07-15 18:58:52 -0400">
            <sequence format="r1" duration="{_t(compound_frames)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
                <spine>
                    <video ref="a1" name="MASTER" offset="0s" start="0s" duration="{_t(compound_frames)}" enabled="1" />
                    <audio ref="a2" name="Mix" offset="0s" start="0s" duration="{_t(compound_frames)}" />
                </spine>
            </sequence>
        </media>
    </resources>
    <library location="file:///tmp/x.fcpbundle/">
        <event name="Auto-Editor Media Group" uid="EVT">{projects}
        </event>
    </library>
</fcpxml>
'''


def build_zip(zip_path, master_src, mix_src, parts, compound_frames):
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('Session/Session_HYBRID.fcpxml',
                    master_fcpxml(master_src, mix_src, parts, compound_frames))
        # Decoys that MUST NOT be mistaken for the master hybrid project:
        zf.writestr('Session/Session_DC.fcpxml', '<fcpxml/>')
        zf.writestr('Session/Session_HYBRID_CAM_29_97.fcpxml', '<fcpxml/>')


# ---------------------------------------------------------------------------
# Independent (frame-arithmetic) ripple reference — does NOT use export internals
# ---------------------------------------------------------------------------
def _subtract_frames(a0, a1, cuts):
    survivors, cur = [], a0
    for cs, ce in cuts:
        if ce <= a0 or cs >= a1:
            continue
        cs, ce = max(cs, a0), min(ce, a1)
        if cs > cur:
            survivors.append((cur, cs))
        if ce > cur:
            cur = ce
        if cur >= a1:
            break
    if cur < a1:
        survivors.append((cur, a1))
    return survivors


def _ripple_frames(t, cuts):
    return t - sum(ce - cs for cs, ce in cuts if ce <= t)


def _segs_to_frames(segments):
    """manifest segment floats -> (trackId, tsFrames, durFrames, srcFrames, file, label)."""
    out = set()
    for s in segments:
        out.add((
            s['trackId'],
            round(s['timelineStart'] / FRAME_F),
            round(s['duration'] / FRAME_F),
            round(s['sourceStart'] / FRAME_F),
            s['file'],
            s['label'],
        ))
    return out


def _expected_after_sequence(orig_segments, spans_frames):
    """Reference model for a REORDERED export: each span lands at the summed length of the
    spans BEFORE it in playback order, and every original segment contributes the part of
    itself that falls inside each span. Built from frame arithmetic only — it never touches
    the export's own collapse machinery, so agreement is real evidence."""
    cum, acc = {}, 0
    for sp in spans_frames:
        cum[sp] = acc
        acc += sp[1] - sp[0]
    expected = set()
    for s in orig_segments:
        ts = round(s['timelineStart'] / FRAME_F)
        dur = round(s['duration'] / FRAME_F)
        src = round(s['sourceStart'] / FRAME_F)
        a0, a1 = ts, ts + dur
        for (ss, se) in spans_frames:
            x, y = max(a0, ss), min(a1, se)
            if x >= y:
                continue
            expected.add((s['trackId'], cum[(ss, se)] + (x - ss), y - x,
                          src + (x - a0), s['file'], s['label']))
    return expected


def _expected_after_cuts(orig_segments, cuts_frames):
    cuts = [(sf, ef) for (sf, ef) in cuts_frames]
    expected = set()
    for s in orig_segments:
        ts = round(s['timelineStart'] / FRAME_F)
        dur = round(s['duration'] / FRAME_F)
        src = round(s['sourceStart'] / FRAME_F)
        a0, a1 = ts, ts + dur
        for (x, y) in _subtract_frames(a0, a1, cuts):
            expected.add((s['trackId'], _ripple_frames(x, cuts), y - x,
                          src + (x - a0), s['file'], s['label']))
    return expected


# ---------------------------------------------------------------------------
class EditorExportTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.master, self.mix = make_media_files(self.tmp)

    # -- helpers ------------------------------------------------------------
    def _build(self, parts, compound_frames):
        zip_path = Path(self.tmp) / 'Session_compounds.zip'
        build_zip(zip_path, self.master, self.mix, parts, compound_frames)
        return zip_path

    def _rezip_edited(self, edited_path):
        """Wrap the loose edited fcpxml in a zip so build_manifest can consume it. The
        entry basename must end in '_HYBRID.fcpxml' for the discovery rule."""
        z = Path(self.tmp) / 'edited_compounds.zip'
        with zipfile.ZipFile(z, 'w') as zf:
            zf.writestr('Session/Session_HYBRID.fcpxml', edited_path.read_bytes())
        return z

    def _assert_export_matches_ripple(self, parts, compound_frames, cuts_frames):
        """The property test. Returns (orig_manifest, edited_manifest) for extra asserts."""
        zip_path = self._build(parts, compound_frames)
        orig = build_manifest(str(zip_path))

        cuts = [{'startFrame': sf, 'endFrame': ef} for (sf, ef) in cuts_frames]
        result = export(str(zip_path), cuts)
        self.assertEqual(result['type'], 'export_result')
        self.assertEqual(result['cutsApplied'], len(cuts_frames))
        edited_path = Path(result['path'])
        self.assertTrue(edited_path.is_file())

        edited = build_manifest(str(self._rezip_edited(edited_path)))

        got = _segs_to_frames(edited['segments'])
        expected = _expected_after_cuts(orig['segments'], cuts_frames)
        self.assertEqual(got, expected,
                         "edited flattened segments must equal original minus cuts (rippled)")

        # Duration shrinks by exactly the total (in-bounds) cut length.
        total_cut = sum(ef - sf for (sf, ef) in cuts_frames)
        exp_dur = round(orig['timelineDuration'] / FRAME_F) - total_cut
        self.assertEqual(round(edited['timelineDuration'] / FRAME_F), exp_dur)
        return orig, edited

    # -- the five spine scenarios, each asserting the ripple property -------
    _PARTS = [[(0, 100, 0), (100, 100, 100), (200, 100, 200)]]   # 3 contiguous clips, 300f
    _COMPOUND = 400

    def test_cut_inside_one_clip_splits(self):
        self._assert_export_matches_ripple(self._PARTS, self._COMPOUND, [(130, 160)])

    def test_cut_spanning_clip_boundary(self):
        self._assert_export_matches_ripple(self._PARTS, self._COMPOUND, [(80, 120)])

    def test_cut_removes_whole_clip(self):
        orig, edited = self._assert_export_matches_ripple(self._PARTS, self._COMPOUND, [(100, 200)])
        # clip B gone entirely -> 2 master segments per track (was 3).
        vids = [s for s in edited['segments'] if s['trackId'] == 'video']
        self.assertEqual(len(vids), 2)

    def test_cut_at_t0(self):
        self._assert_export_matches_ripple(self._PARTS, self._COMPOUND, [(0, 20)])

    def test_cut_at_tail(self):
        self._assert_export_matches_ripple(self._PARTS, self._COMPOUND, [(280, 300)])

    def test_multiple_cuts_combined(self):
        self._assert_export_matches_ripple(
            self._PARTS, self._COMPOUND, [(0, 20), (130, 160), (280, 300)])

    # -- multi-part (concatenated timeline) ---------------------------------
    def test_multipart_cut_spanning_part_boundary(self):
        parts = [
            [(0, 100, 0), (100, 100, 100)],       # part 1: declared 200
            [(0, 100, 300), (100, 100, 400)],     # part 2: declared 200
        ]
        orig, edited = self._assert_export_matches_ripple(parts, 600, [(150, 250)])
        # Each part lost 50 frames -> new sequence durations 150 each, total 300.
        edited_path = Path(self.tmp) / 'Session master edited.fcpxml'
        root = ET.parse(edited_path).getroot()
        durs = [Fraction(*_parse_ts(seq.get('duration'))) / FRAME
                for seq in root.findall('.//project/sequence')]
        self.assertEqual(durs, [150, 150])
        self.assertEqual(round(edited['timelineDuration'] / FRAME_F), 300)

    # -- sequence duration attribute updates --------------------------------
    def test_sequence_durations_updated_on_disk(self):
        parts = [[(0, 100, 0), (100, 100, 100), (200, 100, 200)]]
        zip_path = self._build(parts, 400)
        result = export(str(zip_path), [{'startFrame': 130, 'endFrame': 160}])
        root = ET.parse(result['path']).getroot()
        seqs = root.findall('.//project/sequence')
        self.assertEqual(len(seqs), 1)
        # 300 frames - 30 cut = 270 frames.
        dur = seqs[0].get('duration')
        self.assertEqual(Fraction(*_parse_ts(dur)), 270 * FRAME)

    # -- anchored child trimming & dropping ---------------------------------
    def test_anchored_child_trimmed_and_dropped(self):
        # Single clip [0,300) with a full-span anchored audio child. Two cuts carve it
        # into three pieces; the anchored child in each surviving piece must be trimmed
        # to that piece's window (offset/start advance by the head trim, duration = piece).
        parts = [[(0, 300, 0)]]
        zip_path = self._build(parts, 400)
        result = export(str(zip_path), [{'startFrame': 50, 'endFrame': 100},
                                        {'startFrame': 200, 'endFrame': 250}])
        root = ET.parse(result['path']).getroot()
        spine = root.find('.//project/sequence/spine')
        pieces = spine.findall('ref-clip')
        # survivors of [0,300): [0,50), [100,200), [250,300) -> rippled to [0,50),[50,150),[150,200)
        self.assertEqual(len(pieces), 3)
        exp = [
            # (piece offset, piece dur, child offset, child start, child dur) in frames
            (0, 50, 0, 0, 50),        # head piece: no trim
            (50, 100, 100, 100, 100),  # middle: head-trimmed by 100 -> child offset/start +100
            (150, 50, 250, 250, 50),   # tail: head-trimmed by 250
        ]
        for piece, (po, pd, co, cs, cd) in zip(pieces, exp):
            self.assertEqual(Fraction(*_parse_ts(piece.get('offset'))), po * FRAME)
            self.assertEqual(Fraction(*_parse_ts(piece.get('duration'))), pd * FRAME)
            children = piece.findall('ref-clip')
            self.assertEqual(len(children), 1, "anchored child survives in every piece")
            ch = children[0]
            self.assertEqual(Fraction(*_parse_ts(ch.get('offset'))), co * FRAME)
            self.assertEqual(_start_frac(ch), cs * FRAME)  # zero start stays absent
            self.assertEqual(Fraction(*_parse_ts(ch.get('duration'))), cd * FRAME)

    def test_anchored_child_fully_dropped(self):
        # A short anchored child occupying only [0,40) of a clip [0,100). A cut over
        # [0,50) drops the parent's head; the surviving piece [50,100) no longer contains
        # the child, so it must be removed entirely.
        # Build a bespoke ref-clip and run split_spine_element directly.
        parent = ET.fromstring(
            f'<ref-clip ref="rC" offset="0s" duration="{_t(100)}" srcEnable="video">'
            f'<ref-clip ref="rC" lane="-1" offset="0s" duration="{_t(40)}" srcEnable="audio"/>'
            f'</ref-clip>')
        cuts = [(Fraction(0), 50 * FRAME)]
        ripple = make_ripple(cuts)
        pieces = split_spine_element_ext(parent, cuts, ripple)
        self.assertEqual(len(pieces), 1)             # survivor [50,100)
        self.assertEqual(pieces[0].findall('ref-clip'), [])  # short child dropped

    # -- reorder: the OPTIONAL 'sequence' payload ---------------------------
    def _assert_export_matches_sequence(self, parts, compound_frames, cuts_frames, spans_frames):
        """Property test for a reorder: the edited file, re-flattened by the manifest builder,
        must equal the original segments cut apart at the span boundaries and re-laid in
        playback order. Returns (orig_manifest, edited_manifest, spine)."""
        zip_path = self._build(parts, compound_frames)
        orig = build_manifest(str(zip_path))

        cuts = [{'startFrame': sf, 'endFrame': ef} for (sf, ef) in cuts_frames]
        result = export(str(zip_path), cuts, [_span(a, b) for (a, b) in spans_frames])
        self.assertEqual(result['type'], 'export_result')
        edited_path = Path(result['path'])
        self.assertTrue(edited_path.is_file())

        edited = build_manifest(str(self._rezip_edited(edited_path)))
        self.assertEqual(_segs_to_frames(edited['segments']),
                         _expected_after_sequence(orig['segments'], spans_frames),
                         "reordered segments must equal the survivors re-laid in playback order")

        # Length is a property of WHICH footage survives, never of its order.
        total_kept = sum(b - a for (a, b) in spans_frames)
        self.assertEqual(round(edited['timelineDuration'] / FRAME_F), total_kept)

        # ONE project replaces the parts, and its spine is contiguous and ascending.
        root = ET.parse(edited_path).getroot()
        projects = root.findall('.//project')
        self.assertEqual(len(projects), 1, "a reorder collapses every part into one project")
        seq = projects[0].find('sequence')
        self.assertEqual(Fraction(*_parse_ts(seq.get('duration'))), total_kept * FRAME)
        # Inherited sequence attributes keep the file importable.
        self.assertEqual(seq.get('format'), 'r1')
        self.assertEqual(seq.get('tcFormat'), 'NDF')
        spine = seq.find('spine')
        self.assertEqual(_spine_layout(spine), _contiguous_layout(spine),
                         "spine offsets must be ascending, gap-free and non-overlapping")
        return orig, edited, spine

    def test_absent_sequence_is_the_untouched_ripple_path(self):
        # Regression guard for the whole feature: with no 'sequence' the export must still be
        # apply_cuts' in-place ripple, byte for byte — same parts, same names, same bytes.
        parts = [[(0, 100, 0), (100, 100, 100)], [(0, 100, 300), (100, 100, 400)]]
        zip_path = self._build(parts, 600)
        cuts = [{'startFrame': 150, 'endFrame': 250}]
        got = Path(export(str(zip_path), cuts)['path']).read_bytes()

        with zipfile.ZipFile(zip_path) as zf:
            tree = ET.parse(zf.open('Session/Session_HYBRID.fcpxml'))
        apply_cuts(tree, 'reference', cuts)
        ref = Path(self.tmp) / 'reference.fcpxml'
        FCPXMLUtils.save_fcpxml(tree, str(ref))
        self.assertEqual(got, ref.read_bytes())
        self.assertEqual(got, Path(export(str(zip_path), cuts, None)['path']).read_bytes())
        self.assertEqual(len(ET.parse(ref).getroot().findall('.//project')), 2)

    def test_reverse_two_spans(self):
        # Cut [100,150) leaves survivors [0,100) and [150,300); play the tail first.
        _orig, _edited, spine = self._assert_export_matches_sequence(
            self._PARTS, self._COMPOUND, [(100, 150)], [(150, 300), (0, 100)])
        # [150,300) is 150f of footage (the second half of clip B + clip C), then [0,100).
        self.assertEqual(_spine_layout(spine),
                         [(0, 50), (50, 100), (150, 100)])

    def test_identity_sequence_matches_the_cut_export(self):
        # The survivors in SOURCE order: a different code path (collapse, one project) that
        # must land exactly the footage the ripple path lands.
        zip_path = self._build(self._PARTS, self._COMPOUND)
        orig = build_manifest(str(zip_path))
        _o, edited, spine = self._assert_export_matches_sequence(
            self._PARTS, self._COMPOUND, [(100, 150)], [(0, 100), (150, 300)])
        self.assertEqual(_segs_to_frames(edited['segments']),
                         _expected_after_cuts(orig['segments'], [(100, 150)]))
        self.assertEqual(_spine_layout(spine), [(0, 100), (100, 50), (150, 100)])

    def test_drag_second_half_in_front_with_no_cuts(self):
        # The headline case: no cuts at all, the user drags the back half of the timeline in
        # front of the front half. The split at 150 is a clip edge, not a cut boundary, so
        # nothing in the cut list marks it — the sequence alone says where to divide.
        _o, edited, spine = self._assert_export_matches_sequence(
            self._PARTS, self._COMPOUND, [], [(150, 300), (0, 150)])
        self.assertEqual(_spine_layout(spine),
                         [(0, 50), (50, 100), (150, 100), (250, 50)])
        self.assertEqual(_start_frac(list(spine)[0]), 150 * FRAME)   # tail half plays first
        self.assertEqual(round(edited['timelineDuration'] / FRAME_F), 300)

    def test_split_at_a_non_cut_boundary_with_cuts_elsewhere(self):
        # One cut at the head; the survivor run [20,300) is then divided at 150 — a boundary
        # the cut list knows nothing about — and the halves are swapped.
        _o, edited, spine = self._assert_export_matches_sequence(
            self._PARTS, self._COMPOUND, [(0, 20)], [(150, 300), (20, 150)])
        self.assertEqual(_spine_layout(spine), [(0, 50), (50, 100), (150, 80), (230, 50)])
        self.assertEqual(round(edited['timelineDuration'] / FRAME_F), 280)

    def test_three_way_split_of_one_survivor_run_permuted(self):
        # No cuts: one survivor run divided in three and permuted C, B, A. Both boundaries
        # (50, 250) fall MID-CLIP, where nothing in the source already splits the spine — so
        # only the sequence can put them there. No two spans are adjacent in the source AND
        # consecutive in playback, so all three divisions really have to be made.
        _o, edited, spine = self._assert_export_matches_sequence(
            self._PARTS, self._COMPOUND, [], [(250, 300), (50, 250), (0, 50)])
        self.assertEqual(_spine_layout(spine),
                         [(0, 50), (50, 50), (100, 100), (200, 50), (250, 50)])
        self.assertEqual([_start_frac(el) for el in spine],
                         [250 * FRAME, 50 * FRAME, 100 * FRAME, 200 * FRAME, Fraction(0)])
        self.assertEqual(round(edited['timelineDuration'] / FRAME_F), 300)

    def test_spans_left_in_order_are_not_split(self):
        # Dividing the run at 150 but leaving the halves in place is a no-op edit: the export
        # must not introduce a cut point the order does not need. Three clip pieces, not four.
        zip_path = self._build(self._PARTS, self._COMPOUND)
        result = export(str(zip_path), [], [_span(0, 150), _span(150, 300)])
        spine = ET.parse(result['path']).getroot().find('.//project/sequence/spine')
        self.assertEqual(_spine_layout(spine), [(0, 100), (100, 100), (200, 100)])
        self.assertAlmostEqual(result['newDurationSeconds'], float(300 * FRAME), places=9)

    def test_permutation_across_a_part_seam(self):
        # Two 200f parts (400f concatenated). The cut leaves [0,50) and [100,400) — the second
        # span straddles the part seam at 200 — and the reorder puts that straddling span first.
        parts = [
            [(0, 100, 0), (100, 100, 100)],       # part 1: declared 200
            [(0, 100, 300), (100, 100, 400)],     # part 2: declared 200
        ]
        _o, edited, spine = self._assert_export_matches_sequence(
            parts, 600, [(50, 100)], [(100, 400), (0, 50)])
        self.assertEqual(round(edited['timelineDuration'] / FRAME_F), 350)
        # part1's [100,200) then all of part2, then the head span [0,50).
        self.assertEqual(_spine_layout(spine),
                         [(0, 100), (100, 100), (200, 100), (300, 50)])

    def test_permutation_preserves_total_duration(self):
        parts, cuts = self._PARTS, [(100, 150)]
        spans = [(0, 100), (150, 300)]
        for order in (spans, [spans[1], spans[0]]):
            zip_path = self._build(parts, self._COMPOUND)
            r = export(str(zip_path), [{'startFrame': sf, 'endFrame': ef} for (sf, ef) in cuts],
                       [_span(a, b) for (a, b) in order])
            self.assertAlmostEqual(r['newDurationSeconds'], float(250 * FRAME), places=9,
                                   msg="reordering moves footage; it never changes length")

    def test_per_story_export_honors_the_order(self):
        # Story A owns [0,50) and [200,250) — one piece in each survivor span. With the spans
        # reversed, A's own timeline must play its [200,250) piece first.
        zip_path = self._build(self._PARTS, self._COMPOUND)
        stories = [{'number': 1, 'title': 'Story A',
                    'regions': [{'start': _s(0), 'end': _s(50)},
                                {'start': _s(200), 'end': _s(250)}]}]
        result = export_stories(
            str(zip_path), [{'startFrame': 100, 'endFrame': 150}], stories,
            [_span(150, 300), _span(0, 100)])
        self.assertEqual(result['type'], 'story_export_result')
        root = ET.parse(result['path']).getroot()
        proj = [p for p in root.findall('.//project') if p.get('name') == 'Story A']
        self.assertEqual(len(proj), 1)
        spine = proj[0].find('sequence/spine')
        self.assertEqual(_spine_layout(spine), [(0, 50), (50, 50)])
        # The piece now at offset 0 is the one sourced from frame 200.
        self.assertEqual(_start_frac(list(spine)[0]), 200 * FRAME)

    def test_per_story_kept_interval_divided_by_a_span_boundary(self):
        # No cuts, spans swapped at 150. Story A owns [100,200), which STRADDLES that
        # boundary: its two halves must be divided and swapped inside the story's own
        # timeline too, or the far half would ride along with the near half.
        zip_path = self._build(self._PARTS, self._COMPOUND)
        stories = [{'number': 1, 'title': 'Story A',
                    'regions': [{'start': _s(100), 'end': _s(200)}]}]
        result = export_stories(str(zip_path), [], stories, [_span(150, 300), _span(0, 150)])
        root = ET.parse(result['path']).getroot()
        spine = [p for p in root.findall('.//project')
                 if p.get('name') == 'Story A'][0].find('sequence/spine')
        self.assertEqual(_spine_layout(spine), [(0, 50), (50, 50)])
        self.assertEqual([_start_frac(el) for el in spine], [150 * FRAME, 100 * FRAME])
        self.assertAlmostEqual([r for r in result['stories'] if r['number'] == 1][0]
                               ['durationSeconds'], float(100 * FRAME), places=9)

    # -- reorder rejection (loud, whole export refused) ----------------------
    def _expect_sequence_error(self, cuts, sequence, needle):
        zip_path = self._build(self._PARTS, self._COMPOUND)
        with self.assertRaises(ManifestError) as ctx:
            export(str(zip_path), cuts, sequence)
        self.assertIn(needle, str(ctx.exception))

    def test_reject_unaligned_sequence_span(self):
        self._expect_sequence_error(
            [], [{'start': _s(0) + FRAME_F / 3, 'end': _s(300)}], 'not frame-aligned')

    def test_reject_sequence_span_crossing_a_cut(self):
        # [0,150) swallows the cut at [100,150): footage the user removed would come back.
        self._expect_sequence_error(
            [{'startFrame': 100, 'endFrame': 150}],
            [_span(0, 150), _span(150, 300)], 'partition')

    def test_reject_sequence_with_a_gap(self):
        # [100,200) is claimed by no span and was never cut — it would vanish silently.
        self._expect_sequence_error([], [_span(0, 100), _span(200, 300)], 'partition')

    def test_reject_overlapping_sequence_spans(self):
        self._expect_sequence_error([], [_span(0, 200), _span(100, 300)], 'overlap')

    def test_reject_sequence_span_out_of_range(self):
        self._expect_sequence_error([], [_span(0, 400)], 'outside the concatenated timeline')

    def test_reject_reversed_sequence_span(self):
        self._expect_sequence_error([], [_span(300, 0)], 'empty or reversed')

    def test_reject_empty_sequence(self):
        self._expect_sequence_error([], [], 'empty sequence')

    def test_cli_accepts_sequence(self):
        zip_path = self._build(self._PARTS, self._COMPOUND)
        proc = subprocess.run(
            [sys.executable, str(CLI), '--zip', str(zip_path)],
            input=json.dumps({'cuts': [{'startFrame': 100, 'endFrame': 150}],
                              'sequence': [_span(150, 300), _span(0, 100)]}),
            capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, f"stderr:\n{proc.stderr}")
        payload = json.loads([ln for ln in proc.stdout.splitlines() if ln.strip()][0])
        self.assertEqual(payload['type'], 'export_result')
        self.assertAlmostEqual(payload['newDurationSeconds'], float(250 * FRAME), places=9)

    def test_cli_rejects_non_array_sequence(self):
        zip_path = self._build(self._PARTS, self._COMPOUND)
        proc = subprocess.run(
            [sys.executable, str(CLI), '--zip', str(zip_path)],
            input=json.dumps({'cuts': [], 'sequence': {'start': 0, 'end': 1}}),
            capture_output=True, text=True)
        self.assertEqual(proc.returncode, 1)
        self.assertIn('must be an array', json.loads(proc.stdout.splitlines()[0])['message'])

    # -- input rejection (loud, whole export refused) -----------------------
    def _expect_error(self, cuts, needle):
        zip_path = self._build(self._PARTS, self._COMPOUND)
        with self.assertRaises(ManifestError) as ctx:
            export(str(zip_path), cuts)
        self.assertIn(needle, str(ctx.exception))

    def test_reject_empty_cuts(self):
        self._expect_error([], 'empty cuts list')

    def test_reject_unsorted_cuts(self):
        self._expect_error([{'startFrame': 200, 'endFrame': 250},
                            {'startFrame': 10, 'endFrame': 20}], 'sorted')

    def test_reject_overlapping_cuts(self):
        self._expect_error([{'startFrame': 10, 'endFrame': 120},
                            {'startFrame': 100, 'endFrame': 150}], 'non-overlapping')

    def test_reject_out_of_bounds_cut(self):
        self._expect_error([{'startFrame': 250, 'endFrame': 999}], 'beyond')

    def test_reject_reversed_cut(self):
        self._expect_error([{'startFrame': 200, 'endFrame': 100}], 'reversed')

    def test_reject_non_integer_frames(self):
        self._expect_error([{'startFrame': 1.5, 'endFrame': 20}], 'integer')

    # -- CLI surface (stdin JSON, single-line result) -----------------------
    def test_cli_success_single_json_line(self):
        zip_path = self._build(self._PARTS, self._COMPOUND)
        proc = subprocess.run(
            [sys.executable, str(CLI), '--zip', str(zip_path)],
            input=json.dumps({'cuts': [{'startFrame': 130, 'endFrame': 160}]}),
            capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, f"stderr:\n{proc.stderr}")
        lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
        self.assertEqual(len(lines), 1, f"expected one stdout line, got: {proc.stdout!r}")
        payload = json.loads(lines[0])
        self.assertEqual(payload['type'], 'export_result')
        self.assertTrue(Path(payload['path']).is_file())
        self.assertEqual(payload['cutsApplied'], 1)
        self.assertAlmostEqual(payload['newDurationSeconds'], float(270 * FRAME), places=9)

    def test_cli_error_shape_and_exit_code(self):
        zip_path = self._build(self._PARTS, self._COMPOUND)
        proc = subprocess.run(
            [sys.executable, str(CLI), '--zip', str(zip_path)],
            input=json.dumps({'cuts': []}),
            capture_output=True, text=True)
        self.assertEqual(proc.returncode, 1)
        lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
        self.assertEqual(len(lines), 1)
        payload = json.loads(lines[0])
        self.assertEqual(payload['type'], 'error')
        self.assertIn('empty cuts list', payload['message'])

    def test_output_serialization_matches_generator(self):
        # Single-quoted xml declaration, no DOCTYPE (matches save_fcpxml / real files).
        zip_path = self._build(self._PARTS, self._COMPOUND)
        result = export(str(zip_path), [{'startFrame': 130, 'endFrame': 160}])
        head = Path(result['path']).read_bytes()[:80]
        self.assertTrue(head.startswith(b"<?xml version='1.0' encoding='utf-8'?>"))
        self.assertNotIn(b'DOCTYPE', Path(result['path']).read_bytes())

    def test_overwrite_existing_output(self):
        zip_path = self._build(self._PARTS, self._COMPOUND)
        r1 = export(str(zip_path), [{'startFrame': 130, 'endFrame': 160}])
        r2 = export(str(zip_path), [{'startFrame': 10, 'endFrame': 20}])  # overwrite, no error
        self.assertEqual(r1['path'], r2['path'])
        self.assertTrue(Path(r2['path']).is_file())


# small helpers reused above -------------------------------------------------
def _parse_ts(s):
    s = s[:-1] if s.endswith('s') else s
    if '/' in s:
        n, d = s.split('/')
        return int(n), int(d)
    return int(s), 1


def _start_frac(el):
    v = el.get('start')
    return Fraction(*_parse_ts(v)) if v else Fraction(0)


def _s(frames):
    """Frames -> the float seconds the frontend sends in a 'sequence' span."""
    return float(frames * FRAME)


def _span(a, b):
    return {'start': _s(a), 'end': _s(b)}


def _spine_layout(spine):
    """[(offset, duration)] in frames for every spine child, in document order."""
    return [(int(Fraction(*_parse_ts(el.get('offset'))) / FRAME),
             int(Fraction(*_parse_ts(el.get('duration'))) / FRAME)) for el in spine]


def _contiguous_layout(spine):
    """What the layout WOULD be if the same durations were laid end to end from 0 — equal to
    the real layout exactly when the spine ascends with no gap and no overlap."""
    out, cursor = [], 0
    for (_off, dur) in _spine_layout(spine):
        out.append((cursor, dur))
        cursor += dur
    return out


# ===========================================================================
# Mic muting under screen audio (muteMicDuringScreen)
# ===========================================================================
# A second, richer fixture: a master project whose spine ref-clips window a CAM compound
# that really does hold the lane structure the generators emit — a trim-pad <gap>, then a
# content <gap> (offset==start==trim) carrying a DISABLED master-audio lane at -1, an
# ENABLED mic lane at -2 and an ENABLED screen lane at -3, each a <clip> whose inner
# <gap>/<audio> pair spans the FULL source duration (xml_utils.create_clip_with_audio_effects).
# The mute pass must split the mic lane and only the mic lane.

TRIM_F = 60          # trim-pad frames at the head of the compound (cam_generator's 2s pad)
COMPOUND_F = 2400    # compound-internal length in frames


def make_mute_media_files(dirpath):
    """master + per-source mic/screen files. Paths are what the sidecar keys tracks on."""
    d = Path(dirpath)
    paths = {}
    for key, name in (('master', 'Session master.mov'),
                      ('mic', 'Session mic audio_processed.wav'),
                      ('screen', 'Session screen audio_processed.wav')):
        p = d / name
        p.write_text(f'fake-{key}-bytes')
        paths[key] = str(p)
    return paths


def _lane_clip_xml(lane, name, ref, enabled_attr, volume):
    """One audio lane inside the compound's content gap — the shape
    xml_utils.create_clip_with_audio_effects emits: the clip WINDOWS a full-source-length
    inner gap via its own offset/duration (and a 'start' once it has been split)."""
    return (
        f'                    <clip lane="{lane}" offset="{_t(TRIM_F)}" name="{name}" '
        f'duration="{_t(COMPOUND_F - TRIM_F)}" tcFormat="NDF"{enabled_attr}>\n'
        f'                        <adjust-volume amount="{volume}" />\n'
        f'                        <gap name="Gap" offset="0s" duration="{_t(COMPOUND_F)}">\n'
        f'                            <audio ref="{ref}" lane="-1" offset="0s" '
        f'duration="{_t(COMPOUND_F)}" role="dialogue.dialogue-1" srcCh="1, 2" />\n'
        f'                        </gap>\n'
        f'                        <audio-channel-source srcCh="1, 2" role="dialogue.dialogue-1">\n'
        f'                            <adjust-voiceIsolation amount="75" />\n'
        f'                        </audio-channel-source>\n'
        f'                    </clip>\n'
    )


def mute_master_fcpxml(paths, clips, extra_lane=''):
    """clips: [(offset, duration, start)] frame specs for the master spine. Each becomes the
    master_project_generator shape: a srcEnable="video" ref-clip into the CAM compound with an
    anchored lane -1 srcEnable="audio" ref-clip into the SAME compound (offset == start)."""
    spine = ''
    for (o, d, s) in clips:
        sa = f' start="{_t(s)}"' if s != 0 else ''
        spine += (
            f'                    <ref-clip ref="rC" offset="{_t(o)}" name="Hybrid Cam" '
            f'duration="{_t(d)}" srcEnable="video"{sa}>\n'
            f'                        <ref-clip ref="rC" lane="-1" offset="{_t(s)}" '
            f'name="Hybrid Cam" duration="{_t(d)}" srcEnable="audio"{sa} />\n'
            f'                    </ref-clip>\n')
    declared = max(o + d for (o, d, _s) in clips)
    lanes = (
        # Master audio: present but DISABLED, exactly as cam_generator emits it when there
        # are external audio sources. It must be skipped (its file is not a transcript track).
        f'                    <clip lane="-1" offset="{_t(TRIM_F)}" name="Session master" '
        f'duration="{_t(COMPOUND_F - TRIM_F)}" enabled="0">\n'
        f'                        <gap name="Gap" offset="0s" duration="{_t(COMPOUND_F)}">\n'
        f'                            <audio ref="a1" lane="-1" offset="0s" '
        f'duration="{_t(COMPOUND_F)}" role="dialogue.dialogue-1" />\n'
        f'                        </gap>\n'
        f'                    </clip>\n'
        + _lane_clip_xml(-2, 'Session mic audio_processed', 'aMic', '', '0.0471005dB')
        + _lane_clip_xml(-3, 'Session screen audio_processed', 'aScr', '', '-6dB')
        + extra_lane)
    return f'''<?xml version='1.0' encoding='utf-8'?>
<fcpxml version="1.13">
    <resources>
        <format id="r1" name="FFVideoFormat1080p2997" frameDuration="1001/30000s" width="1920" height="1080" colorSpace="1-1-1 (Rec. 709)" />
        <asset id="a1" name="MASTER" start="0s" duration="{_t(COMPOUND_F)}" format="r1" hasVideo="1" hasAudio="1" audioSources="1" audioChannels="2">
            <media-rep kind="original-media" src="file://{paths['master']}" />
        </asset>
        <asset id="aMic" name="Mic" start="0s" duration="{_t(COMPOUND_F)}" hasAudio="1" audioSources="1" audioChannels="2">
            <media-rep kind="original-media" src="file://{paths['mic']}" />
        </asset>
        <asset id="aScr" name="Screen" start="0s" duration="{_t(COMPOUND_F)}" hasAudio="1" audioSources="1" audioChannels="2">
            <media-rep kind="original-media" src="file://{paths['screen']}" />
        </asset>
        <asset id="aSfx" name="Sfx" start="0s" duration="{_t(COMPOUND_F)}" hasAudio="1" audioSources="1" audioChannels="2">
            <media-rep kind="original-media" src="file://{paths.get('sfx', paths['screen'])}" />
        </asset>
        <media id="rC" name="Hybrid Cam" uid="CMP" modDate="2026-07-15 18:58:52 -0400">
            <sequence format="r1" duration="{_t(COMPOUND_F)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
                <spine>
                    <gap name="Gap" offset="0s" duration="{_t(TRIM_F)}" />
                    <gap name="Gap" offset="{_t(TRIM_F)}" duration="{_t(COMPOUND_F - TRIM_F)}" start="{_t(TRIM_F)}">
                        <video ref="a1" lane="1" name="MASTER" offset="{_t(TRIM_F)}" start="{_t(TRIM_F)}" duration="{_t(COMPOUND_F - TRIM_F)}" />
{lanes}                    </gap>
                </spine>
            </sequence>
        </media>
    </resources>
    <library location="file:///tmp/x.fcpbundle/">
        <event name="Auto-Editor Media Group" uid="EVT">
            <project name="Session dc part 1" uid="PRJ0">
                <sequence format="r1" duration="{_t(declared)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
                    <spine>
{spine}                    </spine>
                </sequence>
            </project>
        </event>
    </library>
</fcpxml>
'''


def _words(track, start, end, step=0.4, dur=0.3):
    """Evenly spaced words tiling [start, end). The inter-word gap (step - dur) is well under
    both merge gaps, so one call produces exactly ONE merged active span — and the last
    word is stretched to land exactly on `end` so that span is precisely [start, end)."""
    out = []
    t = start
    while t < end - 1e-9:
        out.append({'track': track, 'text': 'w',
                    'timelineStart': round(t, 6), 'timelineEnd': round(min(t + dur, end), 6),
                    'fileStart': 0.0, 'fileEnd': 0.0, 'group': 0})
        t += step
    if out:
        out[-1]['timelineEnd'] = round(end, 6)
    return out


def _sidecar(paths, words, tracks=None):
    return {
        'schemaVersion': 1, 'session': 'Session', 'model': 'test', 'calibration': 'none',
        'frameSeconds': FRAME_F,
        'tracks': tracks if tracks is not None else [
            {'id': 't0', 'label': 'mic audio_processed', 'file': paths['mic']},
            {'id': 't1', 'label': 'screen audio_processed', 'file': paths['screen']},
        ],
        'words': words,
    }


def _ceil_f(sec):
    """Seconds -> the first frame index at or after `sec` (the mute pass snaps starts UP)."""
    import math
    return math.ceil(sec / FRAME_F)


def _floor_f(sec):
    """Seconds -> the last frame index at or before `sec` (the mute pass snaps ends DOWN)."""
    import math
    return math.floor(sec / FRAME_F)


class MicMuteTest(unittest.TestCase):
    """muteMicDuringScreen: split the mic lane inside the compound and disable the blocks
    where the screen talks and the mic does not."""

    # One 60.06s spine clip windowing compound-local [TRIM_F, TRIM_F+1800). Global t maps to
    # compound-local t + TRIM_F, so every expected boundary below is a frame count + 60.
    TIMELINE_F = 1800
    ONE_WINDOW = [(0, TIMELINE_F, TRIM_F)]

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.paths = make_mute_media_files(self.tmp)

    # -- fixture helpers ----------------------------------------------------
    def _build(self, words, clips=None, tracks=None, sidecar=True, extra_lane=''):
        zip_path = Path(self.tmp) / 'Session_compounds.zip'
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
            zf.writestr('Session/Session_HYBRID.fcpxml',
                        mute_master_fcpxml(self.paths, clips or self.ONE_WINDOW, extra_lane))
        tx = Path(self.tmp) / 'Session_transcript.json'
        if sidecar:
            tx.write_text(json.dumps(_sidecar(self.paths, words, tracks)))
        elif tx.exists():
            tx.unlink()
        return zip_path

    @staticmethod
    def _lanes(path, lane):
        """Every <clip> on `lane` inside the compound, in document order, as
        (offset_frames, start_frames, duration_frames, disabled_bool)."""
        root = ET.parse(path).getroot()
        gap = root.find(".//media[@id='rC']/sequence/spine/gap[@start]")
        out = []
        for el in gap.findall('clip'):
            if el.get('lane') != str(lane):
                continue
            out.append((int(Fraction(*_parse_ts(el.get('offset'))) / FRAME),
                        int(_start_frac(el) / FRAME),
                        int(Fraction(*_parse_ts(el.get('duration'))) / FRAME),
                        el.get('enabled') == '0'))
        return out

    def _export(self, zip_path, mute=True, cuts=None):
        return export(str(zip_path), cuts or [{'startFrame': 0, 'endFrame': 10}], None, mute)

    # -- (a)(b)(c) splits land frame-snapped, disabled, and exactly adjacent ---
    def test_single_mute_block_splits_the_mic_lane(self):
        # Screen talks 5..25s; the mic talks 0..4s and 30..40s, so the whole screen stretch
        # is mic-idle and becomes ONE mute block.
        words = (_words('t1', 5.0, 25.0) + _words('t0', 0.0, 4.0) + _words('t0', 30.0, 40.0))
        zip_path = self._build(words)
        result = self._export(zip_path)
        self.assertEqual(result['micMuteBlocks'], 1)

        s, e = _ceil_f(5.0), _floor_f(25.0)          # (a) snapped INWARD onto the frame grid
        self.assertEqual(self._lanes(result['path'], -2), [
            (TRIM_F, 0, s, False),
            (TRIM_F + s, s, e - s, True),            # (b) only the middle piece is disabled
            (TRIM_F + e, e, COMPOUND_F - TRIM_F - e, False),
        ])

    def test_pieces_are_exactly_adjacent_and_preserve_total_duration(self):
        # (c) Fraction-exact tiling: piece k+1's offset/start is piece k's end, and the
        # summed duration is the unsplit lane's duration. Read from the raw attributes so a
        # rounding error anywhere would show up.
        words = (_words('t1', 5.0, 25.0) + _words('t0', 0.0, 4.0) + _words('t0', 35.0, 45.0))
        result = self._export(self._build(words))
        root = ET.parse(result['path']).getroot()
        gap = root.find(".//media[@id='rC']/sequence/spine/gap[@start]")
        pieces = [el for el in gap.findall('clip') if el.get('lane') == '-2']
        self.assertGreater(len(pieces), 1)

        off0 = Fraction(*_parse_ts(pieces[0].get('offset')))
        cursor_off = off0
        cursor_start = _start_frac(pieces[0])
        total = Fraction(0)
        for el in pieces:
            self.assertEqual(Fraction(*_parse_ts(el.get('offset'))), cursor_off)
            self.assertEqual(_start_frac(el), cursor_start)
            dur = Fraction(*_parse_ts(el.get('duration')))
            cursor_off += dur
            cursor_start += dur
            total += dur
        self.assertEqual(off0, TRIM_F * FRAME)
        self.assertEqual(total, (COMPOUND_F - TRIM_F) * FRAME,
                         "splitting must not change the lane's total duration")

    def test_screen_lane_and_disabled_master_lane_are_untouched(self):
        words = (_words('t1', 5.0, 25.0) + _words('t0', 0.0, 4.0))
        result = self._export(self._build(words))
        # The screen lane is the SOURCE of the muting, never a target.
        self.assertEqual(self._lanes(result['path'], -3),
                         [(TRIM_F, 0, COMPOUND_F - TRIM_F, False)])
        # The disabled master-audio lane stays one clip, still disabled.
        self.assertEqual(self._lanes(result['path'], -1),
                         [(TRIM_F, 0, COMPOUND_F - TRIM_F, True)])

    # -- (d) cough / hallucination filtering ---------------------------------
    def test_short_word_poor_mic_span_is_treated_as_noise_and_still_muted(self):
        # ONE 0.3s word at 12s, mid screen speech: shorter than MIC_MIN_SPEECH AND fewer than
        # MIC_MIN_WORDS words -> a cough, not speech. The mute block must NOT be broken by it.
        self.assertLess(0.3, MIC_MIN_SPEECH)
        self.assertLess(1, MIC_MIN_WORDS)
        cough = [{'track': 't0', 'text': 'ahem', 'timelineStart': 12.0, 'timelineEnd': 12.3,
                  'fileStart': 0.0, 'fileEnd': 0.0, 'group': 0}]
        words = _words('t1', 5.0, 25.0) + _words('t0', 0.0, 4.0) + cough
        result = self._export(self._build(words))
        self.assertEqual(result['micMuteBlocks'], 1)
        s, e = _ceil_f(5.0), _floor_f(25.0)
        self.assertEqual(self._lanes(result['path'], -2), [
            (TRIM_F, 0, s, False),
            (TRIM_F + s, s, e - s, True),
            (TRIM_F + e, e, COMPOUND_F - TRIM_F - e, False),
        ])

    # -- (e) padding ---------------------------------------------------------
    def test_real_mic_speech_splits_the_block_and_is_padded(self):
        # FOUR words in 0.55s at 12.0: still shorter than MIC_MIN_SPEECH, but MIC_MIN_WORDS
        # words is enough to count as speech (the rule is long ENOUGH or wordy enough). The
        # single mute block therefore breaks in two — and the hole is MIC_PAD wider on each
        # side than the speech itself, so the host's first and last word survive.
        talk = [{'track': 't0', 'text': 'w', 'timelineStart': 12.0 + i * 0.15,
                 'timelineEnd': 12.1 + i * 0.15, 'fileStart': 0.0, 'fileEnd': 0.0, 'group': 0}
                for i in range(MIC_MIN_WORDS + 1)]
        speech_start, speech_end = 12.0, 12.1 + MIC_MIN_WORDS * 0.15
        self.assertLess(speech_end - speech_start, MIC_MIN_SPEECH)
        words = _words('t1', 5.0, 25.0) + _words('t0', 0.0, 4.0) + talk
        result = self._export(self._build(words))
        self.assertEqual(result['micMuteBlocks'], 2)

        a0, a1 = _ceil_f(5.0), _floor_f(speech_start - MIC_PAD)
        b0, b1 = _ceil_f(speech_end + MIC_PAD), _floor_f(25.0)
        self.assertEqual(self._lanes(result['path'], -2), [
            (TRIM_F, 0, a0, False),
            (TRIM_F + a0, a0, a1 - a0, True),
            (TRIM_F + a1, a1, b0 - a1, False),
            (TRIM_F + b0, b0, b1 - b0, True),
            (TRIM_F + b1, b1, COMPOUND_F - TRIM_F - b1, False),
        ])
        # The live hole really is wider than the speech, on BOTH sides, by ~MIC_PAD.
        self.assertLess(a1 * FRAME_F, speech_start)
        self.assertGreater(b0 * FRAME_F, speech_end)
        self.assertAlmostEqual(speech_start - a1 * FRAME_F, MIC_PAD, delta=FRAME_F)
        self.assertAlmostEqual(b0 * FRAME_F - speech_end, MIC_PAD, delta=FRAME_F)

    def test_mute_block_shorter_than_the_minimum_is_dropped(self):
        # Screen talks for a second only — below MIN_MUTE_BLOCK, so nothing is emitted and
        # the lane is left whole. An empty mute set is a legitimate outcome, not an error.
        self.assertLess(1.0, MIN_MUTE_BLOCK)
        words = _words('t1', 5.0, 6.0) + _words('t0', 20.0, 30.0)
        result = self._export(self._build(words))
        self.assertEqual(result['micMuteBlocks'], 0)
        self.assertEqual(self._lanes(result['path'], -2),
                         [(TRIM_F, 0, COMPOUND_F - TRIM_F, False)])

    def test_host_talks_over_everything_yields_no_blocks(self):
        words = _words('t1', 5.0, 25.0) + _words('t0', 0.0, 40.0)
        result = self._export(self._build(words))
        self.assertEqual(result['micMuteBlocks'], 0)
        self.assertEqual(self._lanes(result['path'], -2),
                         [(TRIM_F, 0, COMPOUND_F - TRIM_F, False)])

    def test_screen_pauses_shorter_than_the_merge_gap_do_not_fragment_the_block(self):
        # Two screen stretches a second apart (< SCREEN_MERGE_GAP) are ONE stretch of screen
        # speech, so the mic is muted straight across the pause instead of flickering back on.
        self.assertLess(1.0, SCREEN_MERGE_GAP)
        words = _words('t1', 5.0, 12.0) + _words('t1', 13.0, 25.0) + _words('t0', 30.0, 40.0)
        result = self._export(self._build(words))
        self.assertEqual(result['micMuteBlocks'], 1)

    def test_mic_pauses_shorter_than_the_merge_gap_keep_the_mic_live(self):
        # The host pauses for a second mid-sentence (< MIC_MERGE_GAP) while the screen plays.
        # That is one stretch of host speech: no mute block may open inside it.
        self.assertLess(1.0, MIC_MERGE_GAP)
        words = (_words('t1', 5.0, 25.0)
                 + _words('t0', 6.0, 12.0) + _words('t0', 13.0, 24.0))
        result = self._export(self._build(words))
        self.assertEqual(result['micMuteBlocks'], 0)

    def test_a_mute_covering_the_whole_lane_disables_it_outright(self):
        # The window covers the lane exactly and the screen talks over all of it with the mic
        # silent throughout: the mute has no room to split anything, so the lane must come out
        # as ONE disabled clip rather than being left alone for want of a split point.
        span_f = COMPOUND_F - TRIM_F
        words = _words('t1', 0.0, span_f * FRAME_F)
        result = self._export(self._build(words, clips=[(0, span_f, TRIM_F)]))
        self.assertEqual(result['micMuteBlocks'], 1)
        self.assertEqual(self._lanes(result['path'], -2), [(TRIM_F, 0, span_f, True)])

    # -- compound-local mapping across several windows ------------------------
    def test_mute_maps_through_each_windows_own_source_in_point(self):
        # Two spine clips windowing DIFFERENT stretches of the compound: global t maps to
        # compound-local t+TRIM_F in the first and t+300 in the second. A block in each must
        # land at its own window's offset — a single global shift would put the second wrong.
        clips = [(0, 900, TRIM_F), (900, 900, 1200)]
        words = _words('t1', 5.0, 25.0) + _words('t1', 35.0, 55.0) + _words('t0', 0.0, 4.0)
        result = self._export(self._build(words, clips=clips))
        self.assertEqual(result['micMuteBlocks'], 2)

        a0, a1 = _ceil_f(5.0), _floor_f(25.0)          # window 1: local = global + 60
        b0, b1 = _ceil_f(35.0), _floor_f(55.0)         # window 2: local = global + 300
        la0, la1 = a0 + TRIM_F, a1 + TRIM_F
        lb0, lb1 = b0 + 300, b1 + 300
        self.assertEqual(self._lanes(result['path'], -2), [
            (TRIM_F, 0, la0 - TRIM_F, False),
            (la0, la0 - TRIM_F, la1 - la0, True),
            (la1, la1 - TRIM_F, lb0 - la1, False),
            (lb0, lb0 - TRIM_F, lb1 - lb0, True),
            (lb1, lb1 - TRIM_F, COMPOUND_F - lb1, False),
        ])

    # -- the edited file is still a valid, correctly-flattening project --------
    def test_edited_file_reflattens_with_a_hole_in_the_mic_track(self):
        # End-to-end evidence, not just attribute reading: run the MANIFEST BUILDER (which is
        # strict about compound structure and drops enabled="0" subtrees) over the exported
        # file. The mic track must come back as exactly the two live stretches around the
        # muted block, while the screen track is still one unbroken run.
        words = _words('t1', 5.0, 25.0) + _words('t0', 0.0, 4.0) + _words('t0', 30.0, 40.0)
        zip_path = self._build(words)
        cuts = [{'startFrame': self.TIMELINE_F - 10, 'endFrame': self.TIMELINE_F}]
        result = export(str(zip_path), cuts, None, True)

        rezipped = Path(self.tmp) / 'edited_compounds.zip'
        with zipfile.ZipFile(rezipped, 'w') as zf:
            zf.writestr('Session/Session_HYBRID.fcpxml', Path(result['path']).read_bytes())
        manifest = build_manifest(str(rezipped))

        by_label = {t['id']: t['label'] for t in manifest['tracks']}
        spans = {}
        for seg in manifest['segments']:
            label = by_label[seg['trackId']]
            if label.startswith('mic') or label.startswith('screen'):
                spans.setdefault(label, []).append(
                    (round(seg['timelineStart'] / FRAME_F),
                     round((seg['timelineStart'] + seg['duration']) / FRAME_F)))
        for v in spans.values():
            v.sort()
        s, e = _ceil_f(5.0), _floor_f(25.0)
        end = self.TIMELINE_F - 10
        self.assertEqual(spans['mic audio_processed'], [(0, s), (e, end)])
        self.assertEqual(spans['screen audio_processed'], [(0, end)])

    # -- (f) loud failures ----------------------------------------------------
    def test_missing_transcript_with_the_flag_is_a_loud_error(self):
        zip_path = self._build(_words('t1', 5.0, 25.0), sidecar=False)
        with self.assertRaises(ManifestError) as ctx:
            self._export(zip_path)
        self.assertIn('transcribe the session first', str(ctx.exception))

    def test_missing_transcript_without_the_flag_exports_normally(self):
        zip_path = self._build(_words('t1', 5.0, 25.0), sidecar=False)
        result = self._export(zip_path, mute=False)
        self.assertNotIn('micMuteBlocks', result)

    def test_no_screen_track_is_a_loud_error(self):
        tracks = [{'id': 't0', 'label': 'mic audio_processed', 'file': self.paths['mic']}]
        zip_path = self._build(_words('t0', 0.0, 4.0), tracks=tracks)
        with self.assertRaises(ManifestError) as ctx:
            self._export(zip_path)
        self.assertIn('no screen-audio track', str(ctx.exception))

    def test_unclassifiable_track_is_a_loud_error(self):
        tracks = [{'id': 't0', 'label': 'wibble', 'file': '/tmp/wibble.wav'},
                  {'id': 't1', 'label': 'screen audio_processed', 'file': self.paths['screen']}]
        zip_path = self._build(_words('t1', 5.0, 25.0), tracks=tracks)
        with self.assertRaises(ManifestError) as ctx:
            self._export(zip_path)
        self.assertIn('matches no known audio role', str(ctx.exception))
        self.assertIn("'t0'", str(ctx.exception))

    def test_enabled_lane_with_no_transcript_track_is_a_loud_error(self):
        # An extra enabled lane whose file the sidecar knows nothing about: the sidecar is
        # stale, so the mute set may be wrong. Refuse rather than export a half-done edit.
        self.paths['sfx'] = str(Path(self.tmp) / 'Session board.wav')
        Path(self.paths['sfx']).write_text('fake')
        extra = _lane_clip_xml(-4, 'Session board', 'aSfx', '', '-10dB')
        words = _words('t1', 5.0, 25.0) + _words('t0', 0.0, 4.0)
        zip_path = self._build(words, extra_lane=extra)
        with self.assertRaises(ManifestError) as ctx:
            self._export(zip_path)
        self.assertIn('which no transcript track covers', str(ctx.exception))

    def test_known_non_speech_lane_is_left_alone(self):
        # The same extra lane, but the sidecar DOES declare it — as a soundboard, which is
        # neither a mic nor a screen. It must be neither muted nor a reason to mute.
        self.paths['sfx'] = str(Path(self.tmp) / 'Session soundboard.wav')
        Path(self.paths['sfx']).write_text('fake')
        extra = _lane_clip_xml(-4, 'Session soundboard', 'aSfx', '', '-10dB')
        tracks = [{'id': 't0', 'label': 'mic audio_processed', 'file': self.paths['mic']},
                  {'id': 't1', 'label': 'screen audio_processed', 'file': self.paths['screen']},
                  {'id': 't2', 'label': 'soundboard', 'file': self.paths['sfx']}]
        words = _words('t1', 5.0, 25.0) + _words('t0', 0.0, 4.0)
        result = self._export(self._build(words, tracks=tracks, extra_lane=extra))
        self.assertEqual(result['micMuteBlocks'], 1)
        self.assertEqual(self._lanes(result['path'], -4),
                         [(TRIM_F, 0, COMPOUND_F - TRIM_F, False)])
        self.assertEqual(len(self._lanes(result['path'], -2)), 3)

    # -- (g) the flag off changes nothing at all ------------------------------
    def test_flag_absent_is_byte_identical_to_the_pre_feature_export(self):
        words = _words('t1', 5.0, 25.0) + _words('t0', 0.0, 4.0)
        zip_path = self._build(words)          # sidecar PRESENT — it must simply not be read
        cuts = [{'startFrame': 100, 'endFrame': 150}]

        default_flag = Path(export(str(zip_path), cuts)['path']).read_bytes()
        explicit_off = Path(export(str(zip_path), cuts, None, False)['path']).read_bytes()

        with zipfile.ZipFile(zip_path) as zf:
            tree = ET.parse(zf.open('Session/Session_HYBRID.fcpxml'))
        apply_cuts(tree, 'reference', cuts)
        ref = Path(self.tmp) / 'reference.fcpxml'
        FCPXMLUtils.save_fcpxml(tree, str(ref))

        self.assertEqual(default_flag, ref.read_bytes())
        self.assertEqual(explicit_off, ref.read_bytes())
        # ...and with the flag ON the bytes really do differ (the test above is not vacuous).
        self.assertNotEqual(Path(export(str(zip_path), cuts, None, True)['path']).read_bytes(),
                            ref.read_bytes())

    # -- story export + CLI surface ------------------------------------------
    def test_story_export_reports_and_applies_the_muting(self):
        words = _words('t1', 5.0, 25.0) + _words('t0', 0.0, 4.0)
        zip_path = self._build(words)
        stories = [{'number': 1, 'title': 'Story A',
                    'regions': [{'start': _s(0), 'end': _s(900)}]}]
        result = export_stories(str(zip_path), [], stories, None, True)
        self.assertEqual(result['type'], 'story_export_result')
        self.assertEqual(result['micMuteBlocks'], 1)
        self.assertEqual(len(self._lanes(result['path'], -2)), 3)

    def test_story_export_without_the_flag_reports_nothing(self):
        words = _words('t1', 5.0, 25.0) + _words('t0', 0.0, 4.0)
        zip_path = self._build(words)
        stories = [{'number': 1, 'title': 'Story A',
                    'regions': [{'start': _s(0), 'end': _s(900)}]}]
        result = export_stories(str(zip_path), [], stories)
        self.assertNotIn('micMuteBlocks', result)

    def test_cli_accepts_the_flag(self):
        words = _words('t1', 5.0, 25.0) + _words('t0', 0.0, 4.0)
        zip_path = self._build(words)
        proc = subprocess.run(
            [sys.executable, str(CLI), '--zip', str(zip_path)],
            input=json.dumps({'cuts': [{'startFrame': 0, 'endFrame': 10}],
                              'muteMicDuringScreen': True}),
            capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, f"stderr:\n{proc.stderr}")
        payload = json.loads([ln for ln in proc.stdout.splitlines() if ln.strip()][0])
        self.assertEqual(payload['type'], 'export_result')
        self.assertEqual(payload['micMuteBlocks'], 1)

    def test_cli_omitting_the_flag_leaves_the_lane_whole(self):
        words = _words('t1', 5.0, 25.0) + _words('t0', 0.0, 4.0)
        zip_path = self._build(words)
        proc = subprocess.run(
            [sys.executable, str(CLI), '--zip', str(zip_path)],
            input=json.dumps({'cuts': [{'startFrame': 0, 'endFrame': 10}]}),
            capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, f"stderr:\n{proc.stderr}")
        payload = json.loads([ln for ln in proc.stdout.splitlines() if ln.strip()][0])
        self.assertNotIn('micMuteBlocks', payload)
        self.assertEqual(len(self._lanes(payload['path'], -2)), 1)

    def test_cli_rejects_a_non_boolean_flag(self):
        zip_path = self._build(_words('t1', 5.0, 25.0) + _words('t0', 0.0, 4.0))
        proc = subprocess.run(
            [sys.executable, str(CLI), '--zip', str(zip_path)],
            input=json.dumps({'cuts': [{'startFrame': 0, 'endFrame': 10}],
                              'muteMicDuringScreen': 'yes'}),
            capture_output=True, text=True)
        self.assertEqual(proc.returncode, 1)
        self.assertIn('must be a boolean', json.loads(proc.stdout.splitlines()[0])['message'])


def split_spine_element_ext(el, cuts, ripple):
    """Thin wrapper exposing split_spine_element with default frame-alignment checking."""
    from cli.editor_export import split_spine_element
    return split_spine_element(el, cuts, ripple, FRAME, True, 'test')


if __name__ == '__main__':
    unittest.main(verbosity=2)
