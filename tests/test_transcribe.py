#!/usr/bin/env python3
# tests/test_transcribe.py
#
# Tests for cli/transcribe.py. Plain unittest (the repo has no pytest dependency).
# Run:  python tests/test_transcribe.py   (or) python -m unittest tests.test_transcribe
#
# DETERMINISTIC — NO real whisper, NO real ffmpeg. setUp writes two tiny FAKE tool
# scripts to a temp dir:
#   * fake ffmpeg  — ignores the audio, writes the SOURCE path string into the output
#                    wav so the fake whisper can tell which track it is transcribing.
#   * fake whisper — ignores the audio, reads the wav to learn the source, and emits a
#                    canned whisper-shaped <out_prefix>.json (exact -ojf shape: per-word
#                    entries with integer-ms offsets, leading-space text, and a tokens
#                    array carrying 'p'), plus a couple "progress = NN%" stderr lines.
#
# A miniature "Session_compounds.zip" fixture (same hand-written master-hybrid pattern
# as tests/test_editor_manifest.py / tests/test_editor_export.py) provides a master
# audio leaf plus two non-master audio leaves (mic, screen), with the mic file split
# into TWO timeline segments around a cut so the word->timeline mapping, the midpoint
# rule, the cut-drop, and group indices can all be asserted from exact frame arithmetic.

import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CLI = REPO_ROOT / 'cli' / 'transcribe.py'
sys.path.insert(0, str(REPO_ROOT))

# 29.97 NDF frame = 1001/30000 s. Fixture times use the /30000 denominator so they land
# on exact frame boundaries and produce clean expected floats.
FRAME = 1001 / 30000  # ~0.0333666...


def _t(frames):
    """Frames -> FCPX time string in the /30000 base."""
    return '0s' if frames == 0 else f"{frames * 1001}/30000s"


# ---------------------------------------------------------------------------
# Fake tool scripts (written to disk + chmod +x in setUp).
# ---------------------------------------------------------------------------
FAKE_FFMPEG = '''#!/usr/bin/env python3
# Fake ffmpeg: write the -i source path into the output wav (last positional arg) so the
# fake whisper can identify the track. Ignores everything else.
import sys
args = sys.argv[1:]
inp = None
for i, a in enumerate(args):
    if a == '-i':
        inp = args[i + 1]
out = args[-1]
with open(out, 'w') as f:
    f.write(inp or '')
sys.exit(0)
'''

FAKE_WHISPER = '''#!/usr/bin/env python3
# Fake whisper-cli: ignore the audio, read the wav (which holds the source path), and emit
# a canned whisper -ojf JSON to <out_prefix>.json. Progress on stderr. Optional forced
# failure via WHISPER_FAKE_FAIL_ON (substring match on the source path).
import sys, os, json
args = sys.argv[1:]
wav = of = None
for i, a in enumerate(args):
    if a == '-f':
        wav = args[i + 1]
    elif a == '-of':
        of = args[i + 1]
src = ''
try:
    with open(wav) as fh:
        src = fh.read()
except Exception:
    pass

sys.stderr.write("whisper_print_progress_callback: progress =   0%\\n")
sys.stderr.write("whisper_print_progress_callback: progress =  55%\\n")
sys.stderr.write("whisper_print_progress_callback: progress = 100%\\n")

fail_on = os.environ.get('WHISPER_FAKE_FAIL_ON', '')
if fail_on and fail_on in src:
    sys.stderr.write("fake whisper forced failure\\n")
    sys.exit(3)

def word(text, frm, to, ps):
    e = {"timestamps": {"from": "00:00:00,000", "to": "00:00:00,000"},
         "offsets": {"from": frm, "to": to}, "text": text}
    if ps is not None:
        e["tokens"] = [{"text": text.strip(), "p": p} for p in ps]
    return e

if 'mic audio' in src:
    transcription = [
        word(" hello", 0, 500, [0.9, 1.0]),        # seg0, group 0, prob 0.95
        word(" there", 3000, 3500, [0.8]),          # straddler, midpoint in seg0 -> group 0
        word(" cutword", 4800, 5200, [0.5]),        # midpoint in the cut -> DROPPED
        word(" again", 7000, 7400, None),           # seg1, group 1, no tokens -> prob omitted
        word(" [BLANK_AUDIO]", 5000, 5001, [0.1]),  # noise marker -> skipped
        word(" .", 6000, 6001, [0.1]),              # pure punctuation -> skipped
    ]
else:
    transcription = []  # silent screen track -> zero words

data = {"systeminfo": "fake", "model": {"type": "base"}, "params": {},
        "result": {"language": "en"}, "transcription": transcription}
with open(of + '.json', 'w') as fh:
    json.dump(data, fh)
sys.exit(0)
'''


# ---------------------------------------------------------------------------
# Fixture: master-hybrid fcpxml with a master audio leaf + mic + screen leaves.
# ---------------------------------------------------------------------------
def master_fcpxml(master_src, mic_src, screen_src):
    """Compound rC holds three full-span audio leaves: master, mic, screen (in that doc
    order, so mic is discovered before screen). The project spine windows rC with TWO
    ref-clips:
       clip A: offset 0,   start 0,   dur 100f -> each leaf: timeline [0,100)f  src [0,100)f
       clip B: offset 100f, start 200f, dur 100f -> each leaf: timeline [100,200)f src [200,300)f
    So every non-master audio file gets TWO timeline segments with a SOURCE gap
    [100,200)f = [3.336667s, 6.673333s) — the cut region. Declared project duration is
    200f (= max timeline end), satisfying the flattener's coverage check."""
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.13">
    <resources>
        <format id="r1" name="FFVideoFormat1080p2997" frameDuration="1001/30000s" width="1920" height="1080" colorSpace="1-1-1 (Rec. 709)"/>
        <asset id="aMaster" name="Master" start="0s" duration="{_t(300)}" format="r1" hasAudio="1" audioSources="1" audioChannels="2">
            <media-rep kind="original-media" src="file://{master_src}"/>
        </asset>
        <asset id="aMic" name="Mic" start="0s" duration="{_t(300)}" format="r1" hasAudio="1" audioSources="1" audioChannels="1">
            <media-rep kind="original-media" src="file://{mic_src}"/>
        </asset>
        <asset id="aScreen" name="Screen" start="0s" duration="{_t(300)}" format="r1" hasAudio="1" audioSources="1" audioChannels="1">
            <media-rep kind="original-media" src="file://{screen_src}"/>
        </asset>
        <media id="rC" name="Hybrid Cam">
            <sequence format="r1" duration="{_t(300)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
                <spine>
                    <audio ref="aMaster" name="Master" offset="0s" start="0s" duration="{_t(300)}"/>
                    <audio ref="aMic" name="Mic" offset="0s" start="0s" duration="{_t(300)}"/>
                    <audio ref="aScreen" name="Screen" offset="0s" start="0s" duration="{_t(300)}"/>
                </spine>
            </sequence>
        </media>
    </resources>
    <library location="file:///tmp/x.fcpbundle/">
        <event name="Auto-Editor Media Group" uid="EVT">
            <project name="Session hybrid part 1" uid="PRJ">
                <sequence format="r1" duration="{_t(200)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
                    <spine>
                        <ref-clip ref="rC" offset="0s" start="0s" duration="{_t(100)}" name="Slice A"/>
                        <ref-clip ref="rC" offset="{_t(100)}" start="{_t(200)}" duration="{_t(100)}" name="Slice B"/>
                    </spine>
                </sequence>
            </project>
        </event>
    </library>
</fcpxml>
'''


def make_media_files(dirpath):
    master = Path(dirpath) / 'Session master.wav'
    mic = Path(dirpath) / 'Session mic audio.wav'
    screen = Path(dirpath) / 'Session screen.wav'
    for p in (master, mic, screen):
        with open(p, 'w') as f:
            f.write('fake-audio-bytes')
    return str(master), str(mic), str(screen)


def build_zip(zip_path, master_src, mic_src, screen_src):
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('Session/Session_HYBRID.fcpxml',
                    master_fcpxml(master_src, mic_src, screen_src))
        # Decoys that MUST NOT be mistaken for the master hybrid project:
        zf.writestr('Session/Session_DC.fcpxml', '<fcpxml/>')
        zf.writestr('Session/Session_HYBRID_CAM_29_97.fcpxml', '<fcpxml/>')


class TranscribeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.master, self.mic, self.screen = make_media_files(self.tmp)

        self.ffmpeg = os.path.join(self.tmp, 'fake-ffmpeg')
        self.whisper = os.path.join(self.tmp, 'fake-whisper-cli')
        for path, body in ((self.ffmpeg, FAKE_FFMPEG), (self.whisper, FAKE_WHISPER)):
            with open(path, 'w') as f:
                f.write(body)
            os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

        # A readable ggml model file so validation passes and the model name derives to 'base'.
        self.model = os.path.join(self.tmp, 'ggml-base.bin')
        with open(self.model, 'w') as f:
            f.write('fake-model')

        self.zip = str(Path(self.tmp) / 'Session_compounds.zip')
        build_zip(self.zip, self.master, self.mic, self.screen)
        self.sidecar = str(Path(self.tmp) / 'Session_transcript.json')

    # -- helpers ------------------------------------------------------------
    def _run(self, extra=None, env_extra=None, zip_path=None,
             whisper=None, model=None, ffmpeg=None):
        env = os.environ.copy()
        if env_extra:
            env.update(env_extra)
        cmd = [sys.executable, str(CLI),
               '--zip', str(zip_path or self.zip),
               '--whisper-bin', whisper or self.whisper,
               '--whisper-model', model or self.model,
               '--ffmpeg', ffmpeg or self.ffmpeg]
        if extra:
            cmd += extra
        proc = subprocess.run(cmd, capture_output=True, text=True, env=env)
        lines = [json.loads(ln) for ln in proc.stdout.splitlines() if ln.strip()]
        return proc, lines

    def _success_sidecar(self, lines):
        successes = [ln for ln in lines if ln['type'] == 'success']
        self.assertEqual(len(successes), 1, f"expected exactly one success line: {lines}")
        with open(self.sidecar) as f:
            return successes[0], json.load(f)

    def _words_by_text(self, sidecar):
        return {w['text']: w for w in sidecar['words']}

    # -- the core mapping test ---------------------------------------------
    def test_word_to_timeline_mapping_and_grouping(self):
        proc, lines = self._run()
        self.assertEqual(proc.returncode, 0, f"stderr:\n{proc.stderr}")
        success, sidecar = self._success_sidecar(lines)

        # Sidecar scalar fields.
        self.assertEqual(sidecar['schemaVersion'], 1)
        self.assertEqual(sidecar['session'], 'Session')
        self.assertEqual(sidecar['model'], 'base')            # ggml-base.bin -> base
        self.assertEqual(sidecar['calibration'], 'none')
        self.assertAlmostEqual(sidecar['frameSeconds'], FRAME, places=9)

        # Three surviving words (cutword dropped, [BLANK_AUDIO] & '.' skipped); screen silent.
        self.assertEqual(success['result']['wordCount'], 3)
        self.assertEqual(success['result']['tracks'], 2)
        self.assertEqual(len(sidecar['words']), 3)
        self.assertEqual(Path(success['result']['transcriptPath']), Path(self.sidecar))

        by_text = self._words_by_text(sidecar)
        self.assertEqual(set(by_text), {'hello', 'there', 'again'})

        # hello: seg0 (source [0,100)f), group 0, delta 0.
        hello = by_text['hello']
        self.assertEqual(hello['track'], 't0')
        self.assertEqual(hello['group'], 0)
        self.assertAlmostEqual(hello['fileStart'], 0.0, places=6)
        self.assertAlmostEqual(hello['fileEnd'], 0.5, places=6)
        self.assertAlmostEqual(hello['timelineStart'], 0.0, places=6)
        self.assertAlmostEqual(hello['timelineEnd'], 0.5, places=6)
        self.assertAlmostEqual(hello['prob'], 0.95, places=6)  # mean(0.9, 1.0)

        # there: straddler [3.0,3.5]s, midpoint 3.25 < seg0 source end (3.336667) -> group 0,
        # mapped through seg0 (delta 0) even though its end runs past the segment boundary.
        there = by_text['there']
        self.assertEqual(there['group'], 0)
        self.assertAlmostEqual(there['timelineStart'], 3.0, places=6)
        self.assertAlmostEqual(there['timelineEnd'], 3.5, places=6)
        self.assertAlmostEqual(there['prob'], 0.8, places=6)

        # again: seg1 (source [200,300)f), group 1, delta = 100f - 200f = -100f (-3.336667s).
        again = by_text['again']
        self.assertEqual(again['group'], 1)
        self.assertAlmostEqual(again['fileStart'], 7.0, places=6)
        self.assertAlmostEqual(again['fileEnd'], 7.4, places=6)
        self.assertAlmostEqual(again['timelineStart'], 7.0 - 100 * FRAME, places=6)
        self.assertAlmostEqual(again['timelineEnd'], 7.4 - 100 * FRAME, places=6)
        self.assertNotIn('prob', again)  # tokens absent -> prob key omitted (never null)

        # cutword (midpoint 5.0s, inside the cut gap) never appears.
        self.assertNotIn('cutword', by_text)

        # Words sorted by (track, fileStart).
        self.assertEqual([w['text'] for w in sidecar['words']], ['hello', 'there', 'again'])

    def test_master_excluded_and_label_prefix_stripped(self):
        proc, lines = self._run()
        self.assertEqual(proc.returncode, 0, f"stderr:\n{proc.stderr}")
        _success, sidecar = self._success_sidecar(lines)

        files = {t['file'] for t in sidecar['tracks']}
        self.assertNotIn(self.master, files, "master recording must be excluded")
        self.assertEqual(files, {self.mic, self.screen})

        by_id = {t['id']: t for t in sidecar['tracks']}
        self.assertEqual(by_id['t0']['file'], self.mic)   # discovery order: mic before screen
        self.assertEqual(by_id['t1']['file'], self.screen)
        # Labels = filename stem minus the leading "Session " session prefix.
        self.assertEqual(by_id['t0']['label'], 'mic audio')
        self.assertEqual(by_id['t1']['label'], 'screen')

    def test_zero_word_track_is_not_an_error(self):
        # The screen track is silent (fake whisper emits zero entries). It must still
        # appear as a track, contribute nothing, and NOT fail the run.
        proc, lines = self._run()
        self.assertEqual(proc.returncode, 0, f"stderr:\n{proc.stderr}")
        success, sidecar = self._success_sidecar(lines)
        self.assertEqual(success['result']['tracks'], 2)
        self.assertTrue(all(w['track'] == 't0' for w in sidecar['words']),
                        "screen (t1) contributes no words")

    def test_progress_and_success_line_shapes(self):
        proc, lines = self._run()
        self.assertEqual(proc.returncode, 0, f"stderr:\n{proc.stderr}")
        # Every stdout line is a valid JSON object of a known type.
        self.assertTrue(lines)
        for ln in lines:
            self.assertIn(ln['type'], ('progress', 'success'))
        progresses = [ln for ln in lines if ln['type'] == 'progress']
        self.assertTrue(progresses, "at least one progress line")
        for ln in progresses:
            self.assertIsInstance(ln['progress'], int)
            self.assertGreaterEqual(ln['progress'], 0)
            self.assertLessEqual(ln['progress'], 100)
            self.assertIsInstance(ln['message'], str)
        self.assertEqual(progresses[-1]['progress'], 100)
        # Exactly one success, last line, correct result keys.
        self.assertEqual(lines[-1]['type'], 'success')
        result = lines[-1]['result']
        self.assertEqual(set(result), {'transcriptPath', 'wordCount', 'tracks'})

    # -- atomic write: a failure on track 2 leaves NO sidecar ----------------
    def test_failure_on_second_track_leaves_no_sidecar(self):
        proc, lines = self._run(env_extra={'WHISPER_FAKE_FAIL_ON': 'screen'})
        self.assertEqual(proc.returncode, 1)
        errors = [ln for ln in lines if ln['type'] == 'error']
        self.assertEqual(len(errors), 1, f"lines: {lines}")
        self.assertIn('whisper-cli failed', errors[0]['message'])
        self.assertFalse(lines and lines[-1]['type'] == 'success')
        # The atomic write happens only after ALL tracks succeed -> no sidecar, no .tmp.
        self.assertFalse(os.path.exists(self.sidecar),
                         "a failed run must leave NO sidecar")
        leftovers = [p for p in os.listdir(self.tmp) if p.endswith('.tmp')]
        self.assertEqual(leftovers, [], f"no stray tmp sidecar: {leftovers}")

    # -- missing-tool loud errors -------------------------------------------
    def test_missing_whisper_bin_is_loud(self):
        proc, lines = self._run(whisper='/no/such/whisper-cli')
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(lines[-1]['type'], 'error')
        self.assertIn('whisper binary not found', lines[-1]['message'])
        self.assertFalse(os.path.exists(self.sidecar))

    def test_missing_ffmpeg_is_loud(self):
        proc, lines = self._run(ffmpeg='/no/such/ffmpeg')
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(lines[-1]['type'], 'error')
        self.assertIn('ffmpeg binary not found', lines[-1]['message'])

    def test_missing_model_is_loud(self):
        proc, lines = self._run(model='/no/such/ggml-base.bin')
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(lines[-1]['type'], 'error')
        self.assertIn('whisper model not found', lines[-1]['message'])

    # -- max-seconds is accepted (real optional flag) -----------------------
    def test_max_seconds_flag_accepted(self):
        proc, lines = self._run(extra=['--max-seconds', '90'])
        self.assertEqual(proc.returncode, 0, f"stderr:\n{proc.stderr}")
        success, _sidecar = self._success_sidecar(lines)
        self.assertEqual(success['result']['tracks'], 2)


if __name__ == '__main__':
    unittest.main(verbosity=2)
