#!/usr/bin/env python3
# tests/test_editor_manifest.py
#
# Tests for cli/editor_manifest.py. Plain unittest (the repo has no pytest dependency).
# Run:  python tests/test_editor_manifest.py       (or) python -m unittest tests.test_editor_manifest
#
# Builds a miniature "<name>_compounds.zip" fixture on disk with:
#   - a hand-written master hybrid project FCPXML (spine ref-clip -> compound),
#   - a compound with one ENABLED and one DISABLED inner video clip plus one audio clip,
#   - media-rep src pointing at small real temp files so existence checks pass,
# then asserts the exact flattened segment numbers (rational-derived floats), disabled-clip
# exclusion, the missing-file error path, and the single-line JSON CLI output shape.

import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CLI = REPO_ROOT / 'cli' / 'editor_manifest.py'
sys.path.insert(0, str(REPO_ROOT))

from cli.editor_manifest import build_manifest, ManifestError  # noqa: E402

# 29.97 NDF frame = 1001/30000 s. All times use the /30000 denominator so they land on
# exact frame boundaries and produce clean expected floats.
FRAME = 1001 / 30000  # ~0.0333666...


def master_fcpxml(primary_src, mix_src, bg_src=None, same_layer_overlap=False,
                  short_master=False):
    """A minimal master hybrid project.

    Timeline (project spine): one ref-clip -> compound rC, offset 60 frames (2.002s),
    start 0, duration 300 frames (10.01s). Compound rC internal spine:
      - video M (ENABLED, no lane -> layer (0,0)): ref=a1 (the PRIMARY/master file),
        offset 0, start 30 frames (1.001s), dur 300 frames (10.01s) — spans the whole
        ref-clip window [2.002s, 12.012s), so master coverage reaches the declared end.
        With short_master=True its duration is only 150 frames (5.005s) -> the master
        coverage stops at 7.007s, which must be a loud coverage error.
      - video Md (DISABLED): ref=a1, enabled="0", overlapping M on the SAME layer ->
        must be excluded (were it not, the same-layer overlap error would fire).
      - if bg_src: video BG (ENABLED, lane="1" -> layer (0,1)): full-span overlay that
        OVERLAPS M on a DIFFERENT layer -> allowed internally, dropped from output.
      - if same_layer_overlap: a second no-lane ENABLED video overlapping M on the
        SAME layer (0,0) -> must be a hard error.
      - audio A1: ref=a2 (mix.wav) full span -> traversed, then dropped from output.
    Project sequence declared duration = 360 frames (12.012s) = offset(60) + duration(300).
    """
    bg_asset = ''
    bg_clip = ''
    if bg_src is not None:
        bg_asset = f'''
        <asset id="a3" name="BG" start="0s" duration="600600/30000s" format="r1" hasVideo="1">
            <media-rep kind="original-media" src="file://{bg_src}"/>
        </asset>'''
        bg_clip = '''
                    <video ref="a3" name="BG" lane="1" offset="0s" start="0s" duration="300300/30000s" enabled="1"/>'''
    overlap_clip = ''
    if same_layer_overlap:
        # no lane -> same layer (0,0) as M; offset 75 frames (2.5025s), 150 frames long
        # -> [4.5045s, 9.5095s) overlaps M's span.
        overlap_clip = '''
                    <video ref="a1" name="MASTER" offset="75075/30000s" start="0s" duration="150150/30000s" enabled="1"/>'''
    master_dur = '150150/30000s' if short_master else '300300/30000s'
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.13">
    <resources>
        <format id="r1" name="FFVideoFormat1080p2997" frameDuration="1001/30000s" width="1920" height="1080" colorSpace="1-1-1 (Rec. 709)"/>
        <asset id="a1" name="MASTER" start="0s" duration="600600/30000s" format="r1" hasVideo="1" hasAudio="1" audioSources="1" audioChannels="2">
            <media-rep kind="original-media" src="file://{primary_src}"/>
        </asset>
        <asset id="a2" name="Mix" start="0s" duration="600600/30000s" format="r1" hasAudio="1" audioSources="1" audioChannels="2">
            <media-rep kind="original-media" src="file://{mix_src}"/>
        </asset>{bg_asset}
        <media id="rC" name="Hybrid Cam">
            <sequence format="r1" duration="300300/30000s" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
                <spine>
                    <video ref="a1" name="MASTER" offset="0s" start="30030/30000s" duration="{master_dur}" enabled="1"/>{overlap_clip}
                    <video ref="a1" name="MASTER" offset="150150/30000s" start="0s" duration="150150/30000s" enabled="0"/>{bg_clip}
                    <audio ref="a2" name="Mix" offset="0s" start="0s" duration="300300/30000s"/>
                </spine>
            </sequence>
        </media>
    </resources>
    <library location="file:///tmp/x.fcpbundle/">
        <event name="Auto-Editor Media Group" uid="EVT">
            <project name="Session hybrid part 1" uid="PRJ">
                <sequence format="r1" duration="360360/30000s" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
                    <spine>
                        <ref-clip ref="rC" offset="60060/30000s" name="Session - DC CAM" duration="300300/30000s"/>
                    </spine>
                </sequence>
            </project>
        </event>
    </library>
</fcpxml>
'''


def make_media_files(dirpath):
    # 'Session master.mov' matches the pipeline's master naming convention
    # (stem ends with ' master'); 'cam.mov' deliberately does NOT.
    master = Path(dirpath) / 'Session master.mov'
    cam = Path(dirpath) / 'cam.mov'
    mix = Path(dirpath) / 'mix.wav'
    bg = Path(dirpath) / 'earth background.png'
    for p, data in ((master, 'fake-master-bytes'), (cam, 'fake-video-bytes'),
                    (mix, 'fake-audio-bytes'), (bg, 'fake-image-bytes')):
        with open(p, 'w') as f:
            f.write(data)
    return str(master), str(cam), str(mix), str(bg)


def build_zip(zip_path, primary_src, mix_src, bg_src=None, same_layer_overlap=False,
              short_master=False):
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('Session/Session_HYBRID.fcpxml',
                    master_fcpxml(primary_src, mix_src, bg_src=bg_src,
                                  same_layer_overlap=same_layer_overlap,
                                  short_master=short_master))
        # Decoys that MUST NOT be mistaken for the master hybrid project:
        zf.writestr('Session/Session_DC.fcpxml', '<fcpxml/>')
        zf.writestr('Session/Session_SOLO.fcpxml', '<fcpxml/>')
        zf.writestr('Session/Session_HYBRID_CAM_29_97.fcpxml', '<fcpxml/>')  # a hybrid COMPOUND


class EditorManifestTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.master, self.cam, self.mix, self.bg = make_media_files(self.tmp)

    def _approx(self, a, b, msg=''):
        self.assertAlmostEqual(a, b, places=9, msg=msg)

    def _assert_two_master_tracks(self, manifest):
        """The v1 output contract: exactly two tracks, both the master file, with
        identical segment timing on both."""
        self.assertEqual(
            manifest['tracks'],
            [{'id': 'video', 'label': 'Master', 'kind': 'video'},
             {'id': 'audio', 'label': 'Master audio', 'kind': 'audio'}])
        vids = [s for s in manifest['segments'] if s['trackId'] == 'video']
        auds = [s for s in manifest['segments'] if s['trackId'] == 'audio']
        self.assertEqual(len(vids) + len(auds), len(manifest['segments']),
                         'no segments outside the two master tracks')
        self.assertEqual(len(vids), len(auds))
        for v, a in zip(vids, auds):
            self.assertEqual(
                (v['timelineStart'], v['duration'], v['sourceStart'], v['file'], v['label']),
                (a['timelineStart'], a['duration'], a['sourceStart'], a['file'], a['label']),
                'audio track must duplicate the video track timing exactly')
        for s in manifest['segments']:
            self.assertEqual(s['file'], self.master, 'every segment references the master file')
        return vids

    def test_flatten_exact_numbers_and_disabled_exclusion(self):
        zip_path = Path(self.tmp) / 'Session_compounds.zip'
        build_zip(zip_path, self.master, self.mix)

        manifest = build_manifest(str(zip_path))

        self.assertEqual(manifest['schemaVersion'], 1)
        self.assertEqual(manifest['session'], 'Session')
        self._approx(manifest['frameSeconds'], FRAME, 'frameSeconds from format r1')
        self._approx(manifest['timelineDuration'], 12.012, 'declared 360 frames')

        vids = self._assert_two_master_tracks(manifest)

        # DISABLED inner video excluded -> exactly one master segment per track.
        # (Were it included, it would also trip the same-layer overlap error.)
        self.assertEqual(len(vids), 1, 'disabled inner clip must be excluded')
        v = vids[0]
        # timelineStart = ref-clip offset 60 frames = 2.002s
        self._approx(v['timelineStart'], 2.002)
        # duration = inner master clip 300 frames = 10.01s
        self._approx(v['duration'], 10.01)
        # sourceStart = inner clip start 30 frames = 1.001s (no left-clipping)
        self._approx(v['sourceStart'], 1.001)
        self.assertEqual(v['label'], 'Session master')    # master file stem

    def test_non_master_layers_are_dropped(self):
        """A full-span bg overlay and the mix audio lane are traversed internally but
        do not surface: still exactly the two master tracks with identical timing."""
        zip_path = Path(self.tmp) / 'Session_compounds.zip'
        build_zip(zip_path, self.master, self.mix, bg_src=self.bg)

        manifest = build_manifest(str(zip_path))

        vids = self._assert_two_master_tracks(manifest)
        self.assertEqual(len(vids), 1)
        self._approx(vids[0]['timelineStart'], 2.002)
        self._approx(vids[0]['duration'], 10.01)
        self._approx(vids[0]['sourceStart'], 1.001)
        files = {s['file'] for s in manifest['segments']}
        self.assertNotIn(self.bg, files)
        self.assertNotIn(self.mix, files)

    def test_master_identification_error_lists_stems(self):
        """No leaf file stem matches the master convention -> loud error listing stems."""
        zip_path = Path(self.tmp) / 'Session_compounds.zip'
        build_zip(zip_path, self.cam, self.mix)   # 'cam' stem does not match ' master'

        with self.assertRaises(ManifestError) as ctx:
            build_manifest(str(zip_path))
        msg = str(ctx.exception)
        self.assertIn('cannot identify the session master recording', msg)
        self.assertIn("'cam'", msg)
        self.assertIn("'mix'", msg)

    def test_master_coverage_error(self):
        """Master video stopping well short of the declared duration -> loud error
        stating coverage end vs declared duration."""
        zip_path = Path(self.tmp) / 'Session_compounds.zip'
        build_zip(zip_path, self.master, self.mix, short_master=True)

        with self.assertRaises(ManifestError) as ctx:
            build_manifest(str(zip_path))
        msg = str(ctx.exception)
        self.assertIn('master video coverage ends at 7.007', msg)
        self.assertIn('12.012', msg)

    def test_same_layer_overlap_still_errors(self):
        """Internal mechanism: overlapping enabled video on ONE layer is still a hard
        error, even though the layers no longer surface in the output."""
        zip_path = Path(self.tmp) / 'Session_compounds.zip'
        build_zip(zip_path, self.master, self.mix, same_layer_overlap=True)

        with self.assertRaises(ManifestError) as ctx:
            build_manifest(str(zip_path))
        msg = str(ctx.exception)
        self.assertIn('same layer', msg)
        self.assertIn('Session master.mov', msg)

    def test_missing_file_lists_the_path(self):
        missing = str(Path(self.tmp) / 'does_not_exist master.mov')
        zip_path = Path(self.tmp) / 'Session_compounds.zip'
        build_zip(zip_path, missing, self.mix)

        with self.assertRaises(ManifestError) as ctx:
            build_manifest(str(zip_path))
        self.assertIn(missing, str(ctx.exception))
        self.assertIn('not found on disk', str(ctx.exception))

    def test_missing_master_hybrid_entry_errors(self):
        zip_path = Path(self.tmp) / 'Session_compounds.zip'
        with zipfile.ZipFile(zip_path, 'w') as zf:
            zf.writestr('Session/Session_DC.fcpxml', '<fcpxml/>')
            zf.writestr('Session/Session_HYBRID_CAM_x.fcpxml', '<fcpxml/>')  # compound, not master
        with self.assertRaises(ManifestError) as ctx:
            build_manifest(str(zip_path))
        self.assertIn('_HYBRID.fcpxml', str(ctx.exception))

    def test_cli_success_single_json_line(self):
        zip_path = Path(self.tmp) / 'Session_compounds.zip'
        build_zip(zip_path, self.master, self.mix)

        proc = subprocess.run(
            [sys.executable, str(CLI), '--zip', str(zip_path)],
            capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, f"stderr:\n{proc.stderr}")
        lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
        self.assertEqual(len(lines), 1, f"expected exactly one stdout line, got: {proc.stdout!r}")
        payload = json.loads(lines[0])
        self.assertEqual(payload['type'], 'manifest_result')
        self.assertEqual(payload['manifest']['session'], 'Session')
        self.assertEqual([t['id'] for t in payload['manifest']['tracks']], ['video', 'audio'])
        # one master segment on each of the two tracks
        self.assertEqual(len(payload['manifest']['segments']), 2)

    def test_cli_error_shape_and_exit_code(self):
        proc = subprocess.run(
            [sys.executable, str(CLI), '--zip', '/no/such/file_compounds.zip'],
            capture_output=True, text=True)
        self.assertEqual(proc.returncode, 1)
        lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
        self.assertEqual(len(lines), 1)
        payload = json.loads(lines[0])
        self.assertEqual(payload['type'], 'error')
        self.assertIn('zip not found', payload['message'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
