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
    export, apply_cuts, subtract_cuts, make_ripple, format_time,
)
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
        edited_path = Path(self.tmp) / 'Session_HYBRID_edited.fcpxml'
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


def split_spine_element_ext(el, cuts, ripple):
    """Thin wrapper exposing split_spine_element with default frame-alignment checking."""
    from cli.editor_export import split_spine_element
    return split_spine_element(el, cuts, ripple, FRAME, True, 'test')


if __name__ == '__main__':
    unittest.main(verbosity=2)
