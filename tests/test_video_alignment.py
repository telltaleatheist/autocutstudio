#!/usr/bin/env python3
# tests/test_video_alignment.py
#
# Tests for picture alignment as the PRIMARY way a video source is placed on the
# timeline: core.video_align.locate_by_picture and the workflow's per-source
# resolution around it (cli/electron_workflow._measure_video_offset).
#   Run:  python tests/test_video_alignment.py
#
# What matters here is not that a number comes back -- it is WHICH measurement is
# believed, and what happens when none of them can answer. A video placed at 0.0
# because measurement failed lands exactly where an unmeasured clip lands, so
# nothing downstream can tell the two apart; that case must raise.

import io
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
from contextlib import redirect_stderr
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import video_parts as vp
from core.video_align import VideoAlignError


def _have_ffmpeg() -> bool:
    try:
        vp._ffmpeg()
        return True
    except Exception:
        return False


HAVE_FFMPEG = _have_ffmpeg()
FRAME = 1001.0 / 30000.0


def _cut_clip(path, colours, seconds=2, size='160x90', tmpdir=None):
    """A clip of solid colours — unambiguous cuts at known times.

    ``seconds`` may be a single length or one length per colour. Per-colour
    lengths matter for the decoy quadrants: if every feed cuts on the same grid,
    a measurement that ignored the crop would agree with the right answer by
    construction and the test would prove nothing.
    """
    d = Path(tmpdir)
    if not isinstance(seconds, (list, tuple)):
        seconds = [seconds] * len(colours)
    parts = []
    for i, (colour, length) in enumerate(zip(colours, seconds)):
        seg = d / f'{Path(path).stem}_seg{i:02d}.mp4'
        subprocess.run([vp._ffmpeg(), '-v', 'error', '-nostdin', '-y', '-f',
                        'lavfi', '-i',
                        f'color=c={colour}:s={size}:r=30000/1001:d={length}',
                        '-c:v', 'libx264', '-preset', 'ultrafast',
                        '-pix_fmt', 'yuv420p', str(seg)],
                       check=True, capture_output=True)
        parts.append(seg)
    listing = d / f'{Path(path).stem}_list.txt'
    listing.write_text(''.join(f"file '{p}'\n" for p in parts))
    subprocess.run([vp._ffmpeg(), '-v', 'error', '-nostdin', '-y', '-f',
                    'concat', '-safe', '0', '-i', str(listing), '-c', 'copy',
                    str(path)], check=True, capture_output=True)
    return str(path)


# Irregular, mutually incommensurate cut lengths for the feeds that must NOT
# line up with the screen's 2-second grid.
_DECOY_LENGTHS = [1.3, 2.9, 0.7, 3.7, 1.1, 2.3, 0.9, 3.1,
                  1.7, 2.1, 1.9, 0.8, 3.3, 1.5, 2.7, 1.2]


class CompositeMasterTest(unittest.TestCase):
    """locate_by_picture against a master that is a 2x2 composite.

    This is the real geometry: the master carries four feeds at once, so the
    source's own motion is one quarter of what is on screen and competes with
    three unrelated ones. The crop is what makes the method work, so the test
    reproduces the composite rather than a clean single-source reference.
    """

    @classmethod
    def setUpClass(cls):
        if not HAVE_FFMPEG:
            return
        cls.tmp = tempfile.TemporaryDirectory()
        d = Path(cls.tmp.name)
        cls.dir = d

        colours = ['red', 'blue', 'green', 'yellow', 'white', 'magenta',
                   'cyan', 'gray', 'orange', 'purple', 'brown', 'pink',
                   'navy', 'olive', 'teal', 'maroon']
        cls.source = _cut_clip(d / 'screen_source.mp4', colours,
                               seconds=2, tmpdir=d)
        quads = {'screen': cls.source}
        # The other three feeds run the same length but cut on irregular,
        # mutually incommensurate schedules, each rotated so no two share a
        # phase. A measurement that ignored the crop has nothing to lock onto.
        for i, name in enumerate(('cam2', 'cam1', 'game'), start=1):
            lengths = _DECOY_LENGTHS[i * 3:] + _DECOY_LENGTHS[:i * 3]
            quads[name] = _cut_clip(d / f'{name}_source.mp4',
                                    colours[i:] + colours[:i],
                                    seconds=lengths, tmpdir=d)

        # The composite lags the source by a known amount: DELAY seconds of black
        # lead in every quadrant.
        cls.delay = 5.0
        cls.master = d / 'master.mp4'
        # Quadrant order matches MASTER_QUADRANTS: screen TL, cam2 TR, cam1 BL,
        # game BR.
        inputs = []
        for name in ('screen', 'cam2', 'cam1', 'game'):
            inputs += ['-i', str(quads[name])]
        chains = []
        for i in range(4):
            chains.append(
                f"[{i}:v]tpad=start_duration={cls.delay}:start_mode=add:"
                f"color=black,fps=30000/1001[q{i}]")
        chains.append('[q0][q1][q2][q3]xstack=inputs=4:'
                      'layout=0_0|w0_0|0_h0|w0_h0[out]')
        subprocess.run([vp._ffmpeg(), '-v', 'error', '-nostdin', '-y'] + inputs +
                       ['-filter_complex', ';'.join(chains), '-map', '[out]',
                        '-c:v', 'libx264', '-preset', 'ultrafast',
                        '-pix_fmt', 'yuv420p', str(cls.master)],
                       check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        if HAVE_FFMPEG:
            cls.tmp.cleanup()

    @unittest.skipUnless(HAVE_FFMPEG, 'ffmpeg not available')
    def test_finds_the_source_in_its_own_quadrant(self):
        from core.video_align import locate_by_picture
        result = locate_by_picture(
            str(self.source), str(self.master), expected_start=0.0,
            source_type='screen', search_radius_seconds=10.0,
            span_seconds=40.0, log=lambda m: None)
        error = result['start_seconds'] - self.delay
        self.assertLess(abs(error), FRAME,
                        f"off by {error / FRAME:.2f} frames")
        self.assertEqual(result['method'], 'scene-change')

    @unittest.skipUnless(HAVE_FFMPEG, 'ffmpeg not available')
    def test_the_wrong_quadrant_does_not_return_the_right_answer(self):
        # Cropping to 'game' looks at a feed that cuts on a different rhythm.
        # It must not happen to reproduce the screen's offset -- if it did, the
        # crop would not be carrying any information.
        from core.video_align import locate_by_picture
        try:
            result = locate_by_picture(
                str(self.source), str(self.master), expected_start=0.0,
                source_type='game', search_radius_seconds=10.0,
                span_seconds=40.0, log=lambda m: None)
        except VideoAlignError:
            return          # refusing outright is the better outcome
        self.assertGreater(abs(result['start_seconds'] - self.delay), FRAME,
                           'the wrong quadrant produced the right answer, so '
                           'the crop is not actually being applied')

    @unittest.skipUnless(HAVE_FFMPEG, 'ffmpeg not available')
    def test_an_unknown_source_type_is_refused(self):
        # Comparing against the WHOLE composite pits the source against three
        # other feeds. Doing that silently is how a plausible wrong answer gets
        # made, so an unmapped type must raise rather than degrade.
        from core.video_align import locate_by_picture
        with self.assertRaises(VideoAlignError) as ctx:
            locate_by_picture(str(self.source), str(self.master),
                              expected_start=0.0, source_type='bluetooth',
                              log=lambda m: None)
        self.assertIn('quadrant', str(ctx.exception))

    @unittest.skipUnless(HAVE_FFMPEG, 'ffmpeg not available')
    def test_a_source_that_is_not_in_the_reference_is_refused(self):
        from core.video_align import locate_by_picture
        other = _cut_clip(self.dir / 'unrelated.mp4',
                          ['black', 'white', 'gray', 'navy'] * 4,
                          seconds=_DECOY_LENGTHS, tmpdir=self.dir)
        with self.assertRaises(VideoAlignError):
            locate_by_picture(other, str(self.master), expected_start=0.0,
                              source_type='screen', search_radius_seconds=2.0,
                              span_seconds=40.0, log=lambda m: None)


class SpanEscalationTest(unittest.TestCase):
    """Cut matching gets a second, wider look before a worse method takes over.

    Its only failure mode is "not enough cuts in this window", and a wider window
    is the direct fix. Measured on 2026-08-05: a 900s span at the head returned
    exactly the 6-pair minimum and an 890s span before the seam returned 5, so
    the narrow window is genuinely marginal on real material.
    """

    def spans(self, span, duration, at_end=False):
        from core.video_align import _escalating_spans
        return _escalating_spans(span, duration, at_end)

    def test_widens_once_when_there_is_room(self):
        self.assertEqual(self.spans(900.0, 16000.0), [900.0, 2700.0])

    def test_never_asks_for_more_than_the_source_holds(self):
        for span in self.spans(900.0, 1200.0):
            self.assertLessEqual(span, 1200.0)

    def test_does_not_retry_on_a_negligibly_wider_window(self):
        # A source barely longer than the first span has nothing to gain from a
        # second full decode.
        self.assertEqual(self.spans(900.0, 1000.0), [900.0])

    def test_a_source_shorter_than_the_span_still_gets_one_attempt(self):
        self.assertEqual(self.spans(900.0, 400.0), [400.0])


class _FakeMeasurement:
    """Stand-ins for the two measurement backends, so the DECISION can be tested.

    The decision is what this module changed: which of picture and audio is
    believed, and what happens when neither answers. Running the real backends
    would test ffmpeg instead.
    """

    def __init__(self, picture=None, audio=None):
        self.picture, self.audio = picture, audio

    def install(self, case):
        import core.gcc_phat_align as gpa
        import core.video_align as va

        def fake_measure_offset(path, master):
            if isinstance(self.audio, Exception):
                raise self.audio
            if self.audio is None:
                raise RuntimeError('no audio stream')
            return {'tau_seconds': self.audio[0], 'confidence': self.audio[1],
                    'spread_seconds': 0.0,
                    'per_window': [{'confidence': self.audio[1]}] * 3}

        def fake_locate(path, master, **kwargs):
            if isinstance(self.picture, Exception):
                raise self.picture
            if self.picture is None:
                raise VideoAlignError('no cuts and nothing moved')
            return {'start_seconds': self.picture[0],
                    'confidence': self.picture[1], 'spread_seconds': 0.0,
                    'method': 'scene-change'}

        for module, name, replacement in (
                (gpa, 'measure_offset', fake_measure_offset),
                (va, 'locate_by_picture', fake_locate)):
            patcher = unittest.mock.patch.object(module, name, replacement)
            patcher.start()
            case.addCleanup(patcher.stop)


class ResolveVideoOffsetTest(unittest.TestCase):
    """Which measurement is believed, and what happens when none can answer."""

    def resolve(self, picture=None, audio=None, allow_picture=True):
        from cli.electron_workflow import _measure_video_offset
        _FakeMeasurement(picture, audio).install(self)
        with redirect_stderr(io.StringIO()) as err:
            entry = _measure_video_offset('screen', '/x/screen.mp4',
                                          '/x/master.mp4',
                                          allow_picture=allow_picture)
        return entry, err.getvalue()

    def test_picture_beats_audio(self):
        entry, _ = self.resolve(picture=(1.500, 0.9), audio=(1.200, 0.99))
        self.assertAlmostEqual(entry['offsetSeconds'], 1.500)
        self.assertEqual(entry['method'], 'picture-scene-change')
        self.assertAlmostEqual(entry['audioOffsetSeconds'], 1.200)
        self.assertAlmostEqual(entry['pictureOffsetSeconds'], 1.500)

    def test_a_disagreement_beyond_two_frames_is_reported(self):
        # 0.300s is ~9 frames: the recorder lost sync between its own streams.
        entry, log = self.resolve(picture=(1.500, 0.9), audio=(1.200, 0.99))
        self.assertAlmostEqual(entry['disagreementSeconds'], 0.300, places=6)
        self.assertIn('PICTURE', log)
        self.assertIn('AUDIO', log)

    def test_agreement_is_not_reported_as_a_problem(self):
        entry, log = self.resolve(picture=(1.200, 0.9), audio=(1.190, 0.99))
        self.assertIn('disagreementSeconds', entry)
        self.assertNotIn('lost sync', log)

    def test_audio_answers_when_the_picture_cannot(self):
        entry, log = self.resolve(picture=None, audio=(1.200, 0.99))
        self.assertAlmostEqual(entry['offsetSeconds'], 1.200)
        self.assertEqual(entry['method'], 'gcc-phat')
        self.assertTrue(entry['trusted'])
        self.assertNotIn('pictureOffsetSeconds', entry)

    def test_the_picture_answers_when_the_audio_is_silent(self):
        # The case the whole module exists for: a capture whose audio feed was
        # lost still records a full-length empty track.
        entry, _ = self.resolve(picture=(1.500, 0.9), audio=None)
        self.assertAlmostEqual(entry['offsetSeconds'], 1.500)
        self.assertEqual(entry['method'], 'picture-scene-change')
        self.assertNotIn('audioOffsetSeconds', entry)

    def test_neither_method_answering_RAISES_rather_than_placing_at_zero(self):
        from cli.electron_workflow import _measure_video_offset  # noqa: F401
        with self.assertRaises(RuntimeError) as ctx:
            self.resolve(picture=None, audio=None)
        message = str(ctx.exception)
        self.assertIn('0.0', message)
        self.assertIn('screen', message)

    def test_untrusted_audio_alone_is_flagged(self):
        entry, log = self.resolve(picture=None, audio=(1.200, 0.10))
        self.assertFalse(entry['trusted'])
        self.assertIn('VERIFY THIS VIDEO MANUALLY', log)

    def test_picture_is_not_attempted_when_disallowed(self):
        # Stream-recovery mode's master is a downloaded broadcast, not the 2x2
        # composite the quadrant map describes.
        entry, log = self.resolve(picture=(9.999, 0.9), audio=(1.200, 0.99),
                                  allow_picture=False)
        self.assertAlmostEqual(entry['offsetSeconds'], 1.200)
        self.assertEqual(entry['method'], 'gcc-phat')
        self.assertNotIn('pictureOffsetSeconds', entry)
        self.assertIn('not attempted', log)


class AlignmentSidecarTest(unittest.TestCase):
    """The sidecar has to record WHICH method placed each clip.

    It is read back by the transcript editor and by anyone asking why a clip sits
    where it does; 'gcc-phat' on a clip that was actually placed by picture would
    send that question the wrong way.
    """

    def write(self, video_offset_meta):
        from cli.electron_workflow import _write_alignment_sidecar
        import json
        with tempfile.TemporaryDirectory() as d:
            with redirect_stderr(io.StringIO()):
                path = _write_alignment_sidecar(
                    d, 'Session', '/x/master.mp4', {}, {},
                    {'screen': 1.5}, {}, {}, video_offset_meta)
            return json.loads(Path(path).read_text())

    def test_records_the_method_that_answered(self):
        payload = self.write({'screen': {
            'offsetSeconds': 1.5, 'confidence': 0.9, 'trusted': True,
            'method': 'picture-scene-change',
            'pictureOffsetSeconds': 1.5, 'audioOffsetSeconds': 1.2,
            'disagreementSeconds': 0.3}})
        entry = next(s for s in payload['sources'] if s['type'] == 'screen')
        self.assertEqual(entry['method'], 'picture-scene-change')
        self.assertAlmostEqual(entry['audioOffsetSeconds'], 1.2)
        self.assertAlmostEqual(entry['disagreementSeconds'], 0.3)

    def test_a_source_with_no_meta_still_lands_in_the_sidecar(self):
        payload = self.write({})
        entry = next(s for s in payload['sources'] if s['type'] == 'screen')
        self.assertAlmostEqual(entry['offsetSeconds'], 1.5)
        self.assertNotIn('confidence', entry)


if __name__ == '__main__':
    import unittest.mock  # noqa: F401
    unittest.main(verbosity=2)
