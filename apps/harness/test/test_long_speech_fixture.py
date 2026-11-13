"""External acceptance inputs must stay explicit and independent of the live installation."""
import json
from pathlib import Path
import tempfile
import unittest
import wave

from long_speech_acceptance import load_fixture, native_process_id, process_sample, repeated_wave


class ExternalSpeechFixtureTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.manifest = root/'manifest.json'
        self.audio = root/'synthetic.wav'
        self.declaration = {'id':'org.example.acceptance-speech', 'provides':['speech-to-text'],
            'source':{'type':'git', 'repository':'https://example.test/speech.git', 'branch':'test-fixture'},
            'runtimeProfiles':[{'key':'native', 'type':'localCommand'},
                {'key':'development', 'type':'localCommand', 'development':True}],
            'settings':[{'key':'MODEL', 'default':'fixture-model'}]}
        self.manifest.write_text(json.dumps(self.declaration))
        with wave.open(str(self.audio), 'wb') as recording:
            recording.setnchannels(1); recording.setsampwidth(2); recording.setframerate(16000)
            recording.writeframes(b'\0\0' * 1600)
        self.environment = {'HOSTY_SPEECH_ACCEPTANCE_MANIFEST':str(self.manifest),
            'HOSTY_SPEECH_ACCEPTANCE_WAV':str(self.audio), 'HOSTY_SPEECH_ACCEPTANCE_RUNTIME':'native'}

    def test_explicit_provider_source_and_settings_survive_selection(self):
        before = self.manifest.read_bytes()
        path, manifest, audio, runtime = load_fixture(self.environment)
        self.assertEqual((path, audio, runtime), (self.manifest, self.audio, 'native'))
        self.assertEqual(manifest, self.declaration)
        self.assertEqual(self.manifest.read_bytes(), before)
        self.assertEqual(len(repeated_wave(audio)), 19_200_044)

    def test_missing_or_relative_inputs_do_not_select_an_implicit_provider(self):
        for key in ('HOSTY_SPEECH_ACCEPTANCE_MANIFEST', 'HOSTY_SPEECH_ACCEPTANCE_WAV'):
            for value in ('', 'relative-fixture.json', str(self.audio.parent/'missing')):
                with self.subTest(key=key, value=value), self.assertRaisesRegex(ValueError, key):
                    load_fixture({**self.environment, key:value})

    def test_non_speech_app_and_development_runtime_are_refused(self):
        self.manifest.write_text(json.dumps({**self.declaration, 'provides':[]}))
        with self.assertRaisesRegex(ValueError, 'speech-to-text'):
            load_fixture(self.environment)
        self.manifest.write_text(json.dumps(self.declaration))
        for runtime in ('missing', 'development'):
            with self.subTest(runtime=runtime), self.assertRaisesRegex(ValueError, 'production'):
                load_fixture({**self.environment, 'HOSTY_SPEECH_ACCEPTANCE_RUNTIME':runtime})

    def test_non_pcm_baseline_and_empty_audio_are_refused(self):
        for rate, frames in ((48000, b'\0\0'), (16000, b'')):
            with wave.open(str(self.audio), 'wb') as recording:
                recording.setnchannels(1); recording.setsampwidth(2); recording.setframerate(rate)
                recording.writeframes(frames)
            with self.subTest(rate=rate), self.assertRaises(AssertionError):
                load_fixture(self.environment)

    def test_container_pid_is_never_sampled_as_a_local_process(self):
        native = {'runtimeType':'localCommand', 'processId':123}
        docker = {'runtimeType':'docker', 'processId':456}
        for services in ([], [docker], [native, docker], [{'processId':123}]):
            with self.subTest(services=services):
                self.assertIsNone(native_process_id({'services':services}))
        self.assertEqual(native_process_id({'services':[native]}), 123)

    def test_missing_native_pid_has_no_host_wide_metrics(self):
        self.assertIsNone(process_sample(None))


if __name__ == '__main__':
    unittest.main()
