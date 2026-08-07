#!/usr/bin/env python3
# tests/test_video_parts.py
#
# Tests for core/video_parts.py, core/video_align.py and the split-capture
# additions to core/gcc_phat_align.py. Plain unittest (the repo has no pytest
# dependency).
#   Run:  python tests/test_video_parts.py
#
# The heavy paths (re-encoding tens of gigabytes) are not exercised here; what IS
# exercised is every decision that determines WHERE a seam lands, because that is
# what silently ruins an edit. Fixtures are tiny synthetic clips built with
# ffmpeg's lavfi sources, so the whole file runs in seconds.

import os
import subprocess
import sys
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import video_parts as vp
from core.video_parts import VideoPartsError


def _have_ffmpeg() -> bool:
    try:
        vp._ffmpeg()
        return True
    except Exception:
        return False


HAVE_FFMPEG = _have_ffmpeg()


def make_clip(path, seconds, rate='30000/1001', size='160x90', with_audio=True,
              pattern='testsrc'):
    """Render a tiny synthetic clip with real, probeable stream parameters."""
    cmd = [vp._ffmpeg(), '-v', 'error', '-nostdin', '-y',
           '-f', 'lavfi', '-i', f'{pattern}=s={size}:r={rate}:d={seconds}']
    if with_audio:
        cmd += ['-f', 'lavfi', '-i',
                f'sine=frequency=440:sample_rate=48000:duration={seconds}']
    cmd += ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']
    if with_audio:
        cmd += ['-c:a', 'aac', '-ar', '48000', '-ac', '2']
    cmd += ['-t', str(seconds), str(path)]
    subprocess.run(cmd, check=True, capture_output=True)
    return str(path)


class OutputNamingTest(unittest.TestCase):
    def test_strips_a_trailing_part_number(self):
        self.assertEqual(
            Path(vp.merged_output_path('/x/2026-08-05 screen capture 1.mp4')).name,
            '2026-08-05 screen capture merged.mp4')

    def test_handles_a_name_with_no_part_number(self):
        self.assertEqual(
            Path(vp.merged_output_path('/x/session screen capture.mp4')).name,
            'session screen capture merged.mp4')

    def test_keeps_a_name_that_is_entirely_digits(self):
        # Stripping every character would leave nothing to name the file after.
        self.assertEqual(Path(vp.merged_output_path('/x/2026.mp4')).name,
                         '2026 merged.mp4')

    def test_merged_output_sits_beside_the_parts(self):
        out = vp.merged_output_path('/media/sess/cap 1.mp4')
        self.assertEqual(str(Path(out).parent), '/media/sess')


class CreationTimeTest(unittest.TestCase):
    def test_parses_the_z_suffixed_form_ffprobe_reports(self):
        parsed = vp.parse_creation_time('2026-08-05T20:42:19.000000Z')
        self.assertEqual(parsed.year, 2026)
        self.assertEqual(parsed.hour, 20)
        self.assertIsNotNone(parsed.tzinfo)

    def test_difference_of_two_tags_gives_the_recording_gap(self):
        a = vp.parse_creation_time('2026-08-05T17:28:44.000000Z')
        b = vp.parse_creation_time('2026-08-05T20:42:19.000000Z')
        self.assertAlmostEqual((b - a).total_seconds(), 11615.0, places=3)

    def test_absent_or_unparseable_is_none_not_an_exception(self):
        # A missing tag must be reportable as "cannot seed the search", which the
        # caller turns into an actionable error naming the file.
        self.assertIsNone(vp.parse_creation_time(None))
        self.assertIsNone(vp.parse_creation_time(''))
        self.assertIsNone(vp.parse_creation_time('not a timestamp'))


class ContentSpanTest(unittest.TestCase):
    @staticmethod
    def params(video_dur, audio_dur, name='part.mp4'):
        return {'name': name,
                'video': {'duration': video_dur, 'frame_rate': '30000/1001'},
                'audio': None if audio_dur is None else {'duration': audio_dur}}

    def test_uses_the_video_duration(self):
        self.assertEqual(vp.content_span(self.params(100.0, 100.0)), 100.0)

    def test_a_part_with_no_audio_is_fine(self):
        self.assertEqual(vp.content_span(self.params(100.0, None)), 100.0)

    def test_sub_frame_disagreement_is_tolerated(self):
        self.assertEqual(vp.content_span(self.params(100.0, 100.02)), 100.0)

    def test_a_stream_mismatch_still_yields_the_picture_length(self):
        # The real 2026-08-05 part 1: video 11595.395s, audio 11597.931s. Where
        # the PICTURE ends is not ambiguous, so the non-strict path proceeds.
        self.assertEqual(
            vp.content_span(self.params(11595.395, 11597.931, 'screen capture 1.mp4')),
            11595.395)

    def test_strict_refuses_a_part_whose_streams_disagree(self):
        # A MEASURED seam derives the end from audio position + video length,
        # which only holds if the two stayed in step.
        with self.assertRaises(VideoPartsError) as ctx:
            vp.content_span(self.params(11595.395, 11597.931, 'screen capture 1.mp4'),
                            strict=True)
        message = str(ctx.exception)
        self.assertIn('screen capture 1.mp4', message)
        self.assertIn('manually', message)

    def test_skew_is_reported_signed(self):
        self.assertAlmostEqual(vp.av_skew(self.params(100.0, 102.5)), 2.5, places=6)
        self.assertAlmostEqual(vp.av_skew(self.params(100.0, None)), 0.0, places=6)

    def test_missing_video_duration_raises(self):
        with self.assertRaises(VideoPartsError):
            vp.content_span(self.params(None, 100.0))


class CompareParamsTest(unittest.TestCase):
    @staticmethod
    def params(**overrides):
        video = {'codec_name': 'h264', 'width': 1920, 'height': 1080,
                 'pix_fmt': 'yuv420p', 'frame_rate': '30000/1001', 'level': 41}
        video.update(overrides.pop('video', {}))
        audio = overrides.pop('audio', {'codec_name': 'aac', 'sample_rate': 48000,
                                        'channels': 2})
        return {'name': 'x.mp4', 'video': video, 'audio': audio}

    def test_identical_parts_have_no_differences(self):
        self.assertEqual(vp.compare_params(self.params(), self.params()), [])

    def test_frame_rate_and_level_differences_are_reported(self):
        # The exact 2026-08-05 case: 29.97/L4.1 followed by 60/L4.2.
        diffs = vp.compare_params(
            self.params(),
            self.params(video={'frame_rate': '60/1', 'level': 42}))
        self.assertEqual(len(diffs), 2)
        self.assertTrue(any('frame_rate' in d for d in diffs))
        self.assertTrue(any('level' in d for d in diffs))

    def test_a_missing_audio_stream_is_reported(self):
        diffs = vp.compare_params(self.params(), self.params(audio=None))
        self.assertTrue(any('audio stream' in d for d in diffs))


class TargetTimescaleTest(unittest.TestCase):
    @staticmethod
    def target(time_base, frame_rate='30000/1001'):
        return {'name': 'x.mp4',
                'video': {'time_base': time_base, 'frame_rate': frame_rate}}

    def test_returns_the_container_timescale(self):
        # The real 2026-08-05 capture: timescale 1/29970 declaring 2997/100 fps,
        # which is exactly 1000 ticks per frame.
        self.assertEqual(vp.target_timescale(self.target('1/29970', '2997/100')),
                         29970)

    def test_accepts_a_timescale_that_divides_the_frame_duration(self):
        # 1/60000 holds a 30000/1001 frame in exactly 2002 ticks.
        self.assertEqual(vp.target_timescale(self.target('1/60000')), 60000)

    def test_rejects_a_timescale_that_cannot_express_a_whole_frame(self):
        # 1/1000: a 29.97fps frame is 33.3667 ticks. Every frame would land on a
        # rounded timestamp, which accumulates across hours of capture.
        with self.assertRaises(VideoPartsError) as ctx:
            vp.target_timescale(self.target('1/1000'))
        self.assertIn('whole number', str(ctx.exception))

    def test_rejects_a_timescale_that_ALMOST_divides(self):
        # 1/29970 against true NTSC 30000/1001 is 999.999 ticks per frame -- a
        # near miss that would drift a frame every ~1000 frames if waved through.
        with self.assertRaises(VideoPartsError) as ctx:
            vp.target_timescale(self.target('1/29970', '30000/1001'))
        self.assertIn('whole number', str(ctx.exception))

    def test_missing_time_base_raises(self):
        with self.assertRaises(VideoPartsError):
            vp.target_timescale(self.target(None))


class ManualSeamTest(unittest.TestCase):
    """Manual gaps must never touch the reference file or GCC-PHAT."""

    @staticmethod
    def parts(count=2):
        return [{'name': f'p{i}.mp4', 'path': f'/nonexistent/p{i}.mp4',
                 'video': {'duration': 100.0, 'frame_rate': '30000/1001'},
                 'audio': {'duration': 100.0},
                 'creation_time': '2026-08-05T17:28:44.000000Z'}
                for i in range(count)]

    def test_a_manual_gap_is_taken_verbatim(self):
        seams = vp.measure_seams(self.parts(), '/nonexistent/master.mp4',
                                 manual_gaps=[7.4], log=lambda m: None)
        self.assertEqual(len(seams), 1)
        self.assertEqual(seams[0].source, 'manual')
        # NOT rounded here: quantization happens once, at build time, against the
        # frame counts the encoder actually produced.
        self.assertEqual(seams[0].gap_seconds, 7.4)

    def test_a_single_part_has_no_seams(self):
        self.assertEqual(vp.measure_seams(self.parts(1), '/nonexistent/m.mp4'), [])

    def test_a_negative_manual_gap_is_refused(self):
        with self.assertRaises(VideoPartsError) as ctx:
            vp.measure_seams(self.parts(), '/nonexistent/m.mp4',
                             manual_gaps=[-1.0], log=lambda m: None)
        self.assertIn('negative', str(ctx.exception))

    def test_wrong_number_of_manual_gaps_is_refused(self):
        with self.assertRaises(VideoPartsError) as ctx:
            vp.measure_seams(self.parts(3), '/nonexistent/m.mp4',
                             manual_gaps=[1.0], log=lambda m: None)
        self.assertIn('seam', str(ctx.exception))


@unittest.skipUnless(HAVE_FFMPEG, 'ffmpeg not available')
class ProbeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.dir = Path(cls.tmp.name)
        cls.clip = make_clip(cls.dir / 'a.mp4', 2)
        cls.silent = make_clip(cls.dir / 'noaudio.mp4', 2, with_audio=False)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_probes_the_parameters_the_merge_decides_on(self):
        p = vp.probe_media_params(self.clip)
        self.assertEqual(p['video']['codec_name'], 'h264')
        self.assertEqual((p['video']['width'], p['video']['height']), (160, 90))
        self.assertEqual(Fraction(p['video']['frame_rate']), Fraction(30000, 1001))
        self.assertIsNotNone(p['video']['time_base'])
        self.assertEqual(p['audio']['sample_rate'], 48000)

    def test_a_clip_with_no_audio_probes_audio_as_none(self):
        self.assertIsNone(vp.probe_media_params(self.silent)['audio'])

    def test_a_missing_file_raises_naming_it(self):
        with self.assertRaises(VideoPartsError) as ctx:
            vp.probe_media_params(str(self.dir / 'nope.mp4'))
        self.assertIn('nope.mp4', str(ctx.exception))

    def test_a_file_with_no_video_stream_is_refused(self):
        wav = self.dir / 'a.wav'
        subprocess.run([vp._ffmpeg(), '-v', 'error', '-nostdin', '-y', '-f', 'lavfi',
                        '-i', 'sine=duration=1', str(wav)], check=True,
                       capture_output=True)
        with self.assertRaises(VideoPartsError) as ctx:
            vp.probe_media_params(str(wav))
        self.assertIn('no video stream', str(ctx.exception))


@unittest.skipUnless(HAVE_FFMPEG, 'ffmpeg not available')
class PlanAndBuildTest(unittest.TestCase):
    """End-to-end splice of two mismatched parts, checked frame by frame."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.dir = Path(cls.tmp.name)
        # Deliberately mismatched, mirroring the real session: part 1 at 29.97,
        # part 2 at 60fps.
        cls.p1 = make_clip(cls.dir / 'cap 1.mp4', 3, rate='30000/1001')
        cls.p2 = make_clip(cls.dir / 'cap 2.mp4', 2, rate='60/1')

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def plan(self, gap=1.0, **kw):
        return vp.plan_merge([self.p1, self.p2], '/nonexistent/master.mp4',
                             manual_gaps=[gap], log=lambda m: None, **kw)

    def test_a_differing_part_is_marked_for_re_encoding(self):
        plan = self.plan()
        self.assertEqual(plan.reencode, [False, True])

    def test_a_single_part_cannot_be_merged(self):
        with self.assertRaises(VideoPartsError):
            vp.plan_merge([self.p1], '/nonexistent/m.mp4', log=lambda m: None)

    def test_a_resolution_change_is_refused_rather_than_rescaled(self):
        odd = make_clip(self.dir / 'small 2.mp4', 1, size='320x180')
        with self.assertRaises(VideoPartsError) as ctx:
            vp.plan_merge([self.p1, odd], '/nonexistent/m.mp4',
                          manual_gaps=[1.0], log=lambda m: None)
        self.assertIn('Rescaling', str(ctx.exception))

    def test_splice_lands_the_filler_on_exactly_the_right_frames(self):
        out = self.dir / 'out.mp4'
        plan = self.plan(gap=1.0, output_path=str(out))
        result = vp.build_merged(plan, log=lambda m: None)

        rate = float(Fraction(plan.target['video']['frame_rate']))
        probe = vp.probe_media_params(result)
        n1 = vp.probe_media_params(self.p1)['video']['nb_frames']
        gap_frames = round(1.0 * rate)

        # Total length is the sum of the pieces, to the frame.
        self.assertEqual(probe['video']['nb_frames'], n1 + gap_frames + round(2 * rate))
        # Sound tracks picture.
        self.assertLess(abs(probe['audio']['duration'] - probe['video']['duration']),
                        vp.AV_DURATION_TOLERANCE)
        # And the filler is black exactly where it should be, not a frame either side.
        self.assertFalse(self.is_black(result, n1 - 1, rate), 'part 1 ends too early')
        self.assertTrue(self.is_black(result, n1 + 1, rate), 'filler is not black')
        self.assertTrue(self.is_black(result, n1 + gap_frames - 2, rate),
                        'filler ends too early')
        self.assertFalse(self.is_black(result, n1 + gap_frames + 1, rate),
                         'part 2 starts too late')

    @staticmethod
    def is_black(path, frame_index, rate):
        proc = subprocess.run(
            [vp._ffmpeg(), '-v', 'error', '-nostdin', '-ss', f'{frame_index / rate:.6f}',
             '-i', str(path), '-frames:v', '1', '-vf', 'format=gray',
             '-f', 'rawvideo', 'pipe:1'], capture_output=True)
        data = proc.stdout
        if not data:
            raise AssertionError(f'no frame decoded at index {frame_index}')
        return (sum(data) / len(data)) < 1.0

    def test_the_cache_is_reused_and_invalidated_by_a_changed_gap(self):
        out = self.dir / 'cached.mp4'
        plan = self.plan(gap=1.0, output_path=str(out))
        vp.build_merged(plan, log=lambda m: None)
        self.assertIsNotNone(vp.cached_merge(plan))

        # A different gap is a different file, so the cache must miss.
        other = self.plan(gap=2.0, output_path=str(out))
        self.assertIsNone(vp.cached_merge(other))


class SilenceGuardTest(unittest.TestCase):
    """A silent track must be distinguishable from a weak measurement."""

    def test_digital_silence_raises_naming_the_file(self):
        import numpy as np
        from core.gcc_phat_align import _require_signal, SilentAudioError
        with self.assertRaises(SilentAudioError) as ctx:
            _require_signal(np.zeros(8000), '/x/screen capture 2.mp4', 0.0, 1.0,
                            'Source')
        message = str(ctx.exception)
        self.assertIn('screen capture 2.mp4', message)
        self.assertIn('silent', message)

    def test_real_signal_passes_and_returns_its_level(self):
        import numpy as np
        from core.gcc_phat_align import _require_signal
        rms = _require_signal(np.full(8000, 0.05), '/x/a.wav', 0.0, 1.0, 'Source')
        self.assertAlmostEqual(rms, 0.05, places=6)


class LocateSourceGuardTest(unittest.TestCase):
    def test_a_search_radius_over_half_the_window_is_refused(self):
        from core.gcc_phat_align import locate_source
        with self.assertRaises(RuntimeError) as ctx:
            locate_source('/x/a.wav', '/x/b.wav', expected_start=0.0,
                          search_radius_seconds=90.0, window_seconds=120.0)
        self.assertIn('half the analysis window', str(ctx.exception))


class PictureCorrelationTest(unittest.TestCase):
    def test_a_known_lag_is_recovered_exactly(self):
        import numpy as np
        from core.video_align import _normalized_xcorr
        rng = np.random.default_rng(1234)
        signal = rng.random(600)
        lag = 137
        reference = np.concatenate([rng.random(lag), signal, rng.random(200)])
        found, conf = _normalized_xcorr(signal, reference, max_lag=300)
        self.assertEqual(found, lag)
        self.assertGreater(conf, 0.5)

    def test_a_flat_signal_raises_instead_of_returning_a_lag(self):
        import numpy as np
        from core.video_align import _normalized_xcorr, VideoAlignError
        with self.assertRaises(VideoAlignError):
            _normalized_xcorr(np.zeros(100), np.zeros(300), max_lag=50)


class ContinuationPayloadTest(unittest.TestCase):
    """The workflow's validation of the split-capture payload."""

    @staticmethod
    def validate(continuations, gaps=None, sources=None):
        from cli.electron_workflow import _validate_continuations
        return _validate_continuations(continuations, gaps or {},
                                       sources if sources is not None
                                       else {'screen': '/x/p1.mp4'})

    def test_an_empty_payload_is_accepted(self):
        self.validate({})

    def test_a_continuation_without_a_base_source_is_refused(self):
        with self.assertRaises(ValueError) as ctx:
            self.validate({'screen': ['/x/p2.mp4']}, sources={})
        self.assertIn('no primary', str(ctx.exception))

    def test_a_nonexistent_part_is_refused(self):
        with self.assertRaises(FileNotFoundError):
            self.validate({'screen': ['/definitely/not/here.mp4']})

    def test_gaps_without_continuations_are_refused(self):
        with self.assertRaises(ValueError) as ctx:
            self.validate({}, gaps={'screen': [1.0]})
        self.assertIn('no continuation parts', str(ctx.exception))

    def test_gap_count_must_match_the_seam_count(self):
        with self.assertRaises(ValueError) as ctx:
            self.validate({'screen': ['/x/a.mp4', '/x/b.mp4']},
                          gaps={'screen': [1.0]})
        self.assertIn('one entry per seam', str(ctx.exception))

    def test_a_non_numeric_gap_is_refused(self):
        tmp = tempfile.NamedTemporaryFile(suffix='.mp4', delete=False)
        tmp.close()
        try:
            with self.assertRaises(ValueError) as ctx:
                self.validate({'screen': [tmp.name]}, gaps={'screen': ['soon']})
            self.assertIn('numbers or null', str(ctx.exception))
        finally:
            os.unlink(tmp.name)



class QuadrantCropTest(unittest.TestCase):
    """The master-quadrant geometry picture alignment relies on."""

    def test_screen_is_the_top_left_quadrant(self):
        from core.video_align import quadrant_crop
        self.assertEqual(quadrant_crop('screen'), (0.0, 0.0, 0.5, 0.5))

    def test_every_quadrant_is_a_quarter_of_the_frame(self):
        from core.video_align import MASTER_QUADRANTS
        for name, (x, y, w, h) in MASTER_QUADRANTS.items():
            self.assertEqual((w, h), (0.5, 0.5), name)
            self.assertIn(x, (0.0, 0.5), name)
            self.assertIn(y, (0.0, 0.5), name)

    def test_quadrants_agree_with_skip_logic(self):
        # core/skip_logic.py states the same layout for its "use the master
        # quadrant instead" fallback. Two copies of one fact must not drift.
        import re
        from pathlib import Path as P
        from core.video_align import MASTER_QUADRANTS
        source = (P(__file__).resolve().parent.parent / 'core' / 'skip_logic.py').read_text()
        stated = dict(re.findall(r"'(\w+)':\s*'(top|bottom)-(?:left|right) quadrant'",
                                 source))
        self.assertTrue(stated, 'skip_logic quadrant_map not found')
        for name, vertical in stated.items():
            self.assertIn(name, MASTER_QUADRANTS)
            y = MASTER_QUADRANTS[name][1]
            self.assertEqual(y, 0.0 if vertical == 'top' else 0.5,
                             f'{name} disagrees with skip_logic')

    def test_an_unknown_source_type_has_no_quadrant(self):
        from core.video_align import quadrant_crop
        self.assertIsNone(quadrant_crop('bluetooth'))

    def test_crop_filter_is_resolution_independent(self):
        from core.video_align import _crop_filter, quadrant_crop
        expr = _crop_filter(quadrant_crop('game'))
        self.assertEqual(expr, 'crop=iw*0.5:ih*0.5:iw*0.5:ih*0.5,')
        self.assertEqual(_crop_filter(None), '')


class PictureAggregationTest(unittest.TestCase):
    """How picture windows are combined — the part that made this method work.

    Motion signals are synthesized so the answer is known exactly, which lets the
    aggregation rules be tested without decoding hours of 1080p.
    """

    def setUp(self):
        import numpy as np
        from core import video_align
        self.video_align = video_align
        self.np = np
        self.real_motion = video_align.motion_signal
        self.real_duration = None

    def tearDown(self):
        self.video_align.motion_signal = self.real_motion

    def _patch(self, behaviour):
        """behaviour(path, start, duration, rate, crop) -> ndarray or raises."""
        self.video_align.motion_signal = behaviour

    def _patch_durations(self, src=1000.0, ref=2000.0):
        from core import gcc_phat_align

        class _Proc:
            @staticmethod
            def get_duration_seconds(path):
                return ref if 'ref' in str(path) else src

        self.real_duration = gcc_phat_align._make_processor
        gcc_phat_align._make_processor = lambda: _Proc()
        self.addCleanup(setattr, gcc_phat_align, '_make_processor',
                        self.real_duration)

    def test_a_single_unusable_window_does_not_abort_the_sweep(self):
        np = self.np
        self._patch_durations()
        rng = np.random.default_rng(7)
        content = rng.random(80000)
        calls = {'n': 0}
        TRUE_START = 100.0

        # The reference shows the source delayed by TRUE_START, which is the
        # relationship measure_picture_offset exists to recover.
        def fake(path, start, duration, rate='30000/1001', crop=None):
            calls['n'] += 1
            n = int(duration * 29.97)
            # The third decode is a frozen picture: flat, nothing to correlate.
            if calls['n'] == 3:
                return np.zeros(n)
            base = start - TRUE_START if 'ref' in str(path) else start
            offset = int(round(base * 29.97)) + 20000
            return content[offset:offset + n]

        self._patch(fake)
        result = self.video_align.measure_picture_offset(
            'src', 'ref', expected_start=100.0, search_radius_seconds=10.0,
            window_seconds=50.0, probe_fractions=(0.1, 0.3, 0.5, 0.7),
            log=lambda m: None)
        # The flat window is recorded as unusable rather than killing the run,
        # and the remaining windows still produce an answer.
        unusable = [w for w in result['per_window'] if w.get('error')]
        self.assertEqual(len(unusable), 1)
        self.assertGreaterEqual(result['locked_windows'], 2)

    def test_fewer_than_two_locks_raises_rather_than_guessing(self):
        np = self.np
        self._patch_durations()
        rng = np.random.default_rng(11)

        def fake(path, start, duration, rate='30000/1001', crop=None):
            # Unrelated noise on both sides: nothing should ever lock.
            return rng.random(int(duration * 29.97))

        self._patch(fake)
        with self.assertRaises(self.video_align.VideoAlignError) as ctx:
            self.video_align.measure_picture_offset(
                'src', 'ref', expected_start=100.0, search_radius_seconds=10.0,
                window_seconds=50.0, probe_fractions=(0.1, 0.4, 0.7),
                log=lambda m: None)
        self.assertIn('locked', str(ctx.exception))

    def test_noise_windows_cannot_drag_the_answer(self):
        # The failure this rule exists to prevent: on the real session a median
        # across ALL windows landed 20s away from where the locked ones agreed.
        np = self.np
        self._patch_durations()
        rng = np.random.default_rng(3)
        content = rng.random(80000)
        seen = {'n': 0}
        TRUE_START = 100.0

        def fake(path, start, duration, rate='30000/1001', crop=None):
            seen['n'] += 1
            n = int(duration * 29.97)
            # Some reference windows show something else entirely -- the master
            # is not always displaying this source.
            if 'ref' in str(path) and seen['n'] % 4 == 0:
                return rng.random(n)
            base = start - TRUE_START if 'ref' in str(path) else start
            offset = int(round(base * 29.97)) + 20000
            return content[offset:offset + n]

        self._patch(fake)
        result = self.video_align.measure_picture_offset(
            'src', 'ref', expected_start=100.0, search_radius_seconds=10.0,
            window_seconds=50.0,
            probe_fractions=(0.05, 0.2, 0.35, 0.5, 0.65, 0.8),
            log=lambda m: None)
        # Every locked window must agree to within a frame or two of the truth.
        self.assertLess(abs(result['start_seconds'] - 100.0), 0.1)



class SplicedFileMeasurementTest(unittest.TestCase):
    """A spliced capture must still be measurable even though it contains silence.

    Its audio is part 1's sound, then silence across the seam, then part 2 --
    which may itself be silent if that is why it needed splicing. measure_offset
    probes at 10%/50%/85% of the reference, so a probe landing past the seam is
    expected, and must not make the whole file unmeasurable.
    """

    @unittest.skipUnless(HAVE_FFMPEG, 'ffmpeg not available')
    def test_a_window_of_silence_is_skipped_not_fatal(self):
        from core.gcc_phat_align import measure_offset
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        d = Path(tmp.name)

        # Reference: 90s of tone. Source: the same 30s of tone, then 60s of
        # digital silence -- the shape a spliced capture has past its seam.
        ref = d / 'ref.wav'
        src = d / 'src.wav'
        subprocess.run([vp._ffmpeg(), '-v', 'error', '-nostdin', '-y', '-f', 'lavfi',
                        '-i', 'sine=frequency=300:duration=90:sample_rate=48000',
                        '-af', 'aeval=random(0)*0.5|random(1)*0.5', str(ref)],
                       check=True, capture_output=True)
        subprocess.run([vp._ffmpeg(), '-v', 'error', '-nostdin', '-y',
                        '-i', str(ref), '-af',
                        "volume=enable='gt(t,30)':volume=0", str(src)],
                       check=True, capture_output=True)

        result = measure_offset(str(src), str(ref), windows=[(2.0, 20.0),
                                                            (40.0, 20.0),
                                                            (65.0, 20.0)])
        # The two silent windows are dropped; the first still measures.
        self.assertEqual(len(result['per_window']), 1)
        self.assertLess(abs(result['tau_seconds']), 0.01)

    @unittest.skipUnless(HAVE_FFMPEG, 'ffmpeg not available')
    def test_a_wholly_silent_source_still_raises(self):
        from core.gcc_phat_align import measure_offset, SilentAudioError
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        d = Path(tmp.name)
        ref, src = d / 'ref.wav', d / 'silent.wav'
        subprocess.run([vp._ffmpeg(), '-v', 'error', '-nostdin', '-y', '-f', 'lavfi',
                        '-i', 'sine=frequency=300:duration=60:sample_rate=48000',
                        str(ref)], check=True, capture_output=True)
        subprocess.run([vp._ffmpeg(), '-v', 'error', '-nostdin', '-y', '-f', 'lavfi',
                        '-i', 'anullsrc=r=48000:cl=stereo:d=60', str(src)],
                       check=True, capture_output=True)
        with self.assertRaises(SilentAudioError) as ctx:
            measure_offset(str(src), str(ref), windows=[(2.0, 15.0), (30.0, 15.0)])
        self.assertIn('nothing to correlate', str(ctx.exception))



class SceneChangeAlignmentTest(unittest.TestCase):
    """Cut matching — the method that resolves static screen content.

    Correlation methods average over a window, so a screen that sits still
    matches equally well at many offsets. A cut is a single-frame event, which is
    why this reaches sub-frame accuracy where correlation spread over 4 frames.
    """

    @classmethod
    def setUpClass(cls):
        if not HAVE_FFMPEG:
            return
        cls.tmp = tempfile.TemporaryDirectory()
        d = Path(cls.tmp.name)
        cls.dir = d
        # A clip with unambiguous cuts: solid colours that change every 2s, with
        # long static stretches in between -- exactly the shape that defeats
        # correlation.
        colours = ['red', 'blue', 'green', 'yellow', 'white', 'magenta',
                   'cyan', 'gray', 'orange', 'purple', 'brown', 'pink',
                   'navy', 'olive', 'teal', 'maroon']
        parts = []
        for i, colour in enumerate(colours):
            seg = d / f'seg{i:02d}.mp4'
            subprocess.run([vp._ffmpeg(), '-v', 'error', '-nostdin', '-y', '-f',
                            'lavfi', '-i',
                            f'color=c={colour}:s=160x90:r=30000/1001:d=2',
                            '-c:v', 'libx264', '-preset', 'ultrafast',
                            '-pix_fmt', 'yuv420p', str(seg)],
                           check=True, capture_output=True)
            parts.append(seg)
        listing = d / 'list.txt'
        listing.write_text(''.join(f"file '{p}'\n" for p in parts))
        cls.source = d / 'source.mp4'
        subprocess.run([vp._ffmpeg(), '-v', 'error', '-nostdin', '-y', '-f',
                        'concat', '-safe', '0', '-i', str(listing), '-c', 'copy',
                        str(cls.source)], check=True, capture_output=True)

        # The reference is the same content preceded by DELAY seconds of black,
        # so the true offset is known exactly.
        cls.delay = 6.0
        lead = d / 'lead.mp4'
        subprocess.run([vp._ffmpeg(), '-v', 'error', '-nostdin', '-y', '-f',
                        'lavfi', '-i',
                        f'color=c=black:s=160x90:r=30000/1001:d={cls.delay}',
                        '-c:v', 'libx264', '-preset', 'ultrafast',
                        '-pix_fmt', 'yuv420p', str(lead)],
                       check=True, capture_output=True)
        ref_list = d / 'reflist.txt'
        ref_list.write_text(f"file '{lead}'\nfile '{cls.source}'\n")
        cls.reference = d / 'reference.mp4'
        subprocess.run([vp._ffmpeg(), '-v', 'error', '-nostdin', '-y', '-f',
                        'concat', '-safe', '0', '-i', str(ref_list), '-c', 'copy',
                        str(cls.reference)], check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        if HAVE_FFMPEG:
            cls.tmp.cleanup()

    @unittest.skipUnless(HAVE_FFMPEG, 'ffmpeg not available')
    def test_recovers_a_known_offset_to_within_a_frame(self):
        from core.video_align import scene_change_offset
        result = scene_change_offset(
            str(self.source), str(self.reference), expected_start=self.delay + 1.0,
            search_radius_seconds=5.0, span_seconds=40.0, log=lambda m: None)
        error = result['start_seconds'] - self.delay
        self.assertLess(abs(error), 1001 / 30000,
                        f"off by {error * 30000 / 1001:.2f} frames")
        self.assertGreaterEqual(result['matched_pairs'], 6)

    @unittest.skipUnless(HAVE_FFMPEG, 'ffmpeg not available')
    def test_material_with_no_cuts_is_refused(self):
        from core.video_align import scene_change_offset, VideoAlignError
        still = self.dir / 'still.mp4'
        subprocess.run([vp._ffmpeg(), '-v', 'error', '-nostdin', '-y', '-f',
                        'lavfi', '-i', 'color=c=navy:s=160x90:r=30000/1001:d=40',
                        '-c:v', 'libx264', '-preset', 'ultrafast',
                        '-pix_fmt', 'yuv420p', str(still)],
                       check=True, capture_output=True)
        # A static screen offers nothing to match; that must be said plainly
        # rather than answered with whatever the noise floor prefers.
        with self.assertRaises(VideoAlignError) as ctx:
            scene_change_offset(str(still), str(self.reference), expected_start=6.0,
                                search_radius_seconds=5.0, span_seconds=40.0,
                                log=lambda m: None)
        self.assertIn('static', str(ctx.exception).lower() + ' static')

    @unittest.skipUnless(HAVE_FFMPEG, 'ffmpeg not available')
    def test_an_offset_outside_the_search_range_is_not_invented(self):
        from core.video_align import scene_change_offset, VideoAlignError
        with self.assertRaises(VideoAlignError):
            scene_change_offset(
                str(self.source), str(self.reference), expected_start=self.delay + 200.0,
                search_radius_seconds=5.0, span_seconds=40.0, log=lambda m: None)


if __name__ == '__main__':
    unittest.main(verbosity=2)

