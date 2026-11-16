"""Fast checks for crash-fence evidence and bounded consumer reattachment."""
import copy
import importlib.util
import json
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('execution_recovery_acceptance',
    pathlib.Path(__file__).with_name('execution_recovery_acceptance.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class CrashFenceTests(unittest.TestCase):
    def setUp(self):
        self.target = {'ref': {'id': 'run-a', 'provider': {'appId': 'unrelated.provider',
            'installationId': 'installation-a', 'key': 'agent'}},
            'generation': 'generation-a', 'sessionId': 'session-a'}
        self.proof = {'runId': 'run-a', 'generation': 'generation-a', 'sessionId': 'session-a',
            'receipt': {'effectIds': ['private-effect']}, 'providerSession': {'activeRun': 'run-a'},
            'manifest': {'sdkStopConfirmed': False, 'sealed': False, 'spawns': ['spawn-a']},
            'processes': [{'state': 'stopped', 'treeStopped': True}]}
        self.state = {**copy.deepcopy(self.target), 'state': 'unknown', 'phase': 'interrupted',
            'stopConfirmed': False, 'revision': '8', 'effects': {'unresolvedCallIds': ['public-effect']}}

    def check(self, status=409, code='effects_unconfirmed', proof=None, state=None):
        fixture._assert_crash_rejection(status, code,
            self.proof if proof is None else proof, self.state if state is None else state, self.target)

    def test_exact_guard_with_its_own_evidence(self):
        self.check()
        complete = copy.deepcopy(self.proof)
        complete['manifest'].update(sdkStopConfirmed=True, sealed=True)
        self.check(proof=complete)  # The effects guard precedes owned-stop evidence.
        self.check(503, 'exit_unconfirmed')
        complete['processes'][0]['treeStopped'] = False
        self.check(503, 'exit_unconfirmed', proof=complete)

    def test_rejects_status_only_or_unrelated_error_acceptance(self):
        for status, code in [(503, 'effects_unconfirmed'), (409, 'exit_unconfirmed'),
                (503, 'provider_unavailable'), (401, 'effects_unconfirmed')]:
            with self.subTest(status=status, code=code), self.assertRaises(AssertionError):
                self.check(status, code)

    def test_both_effect_views_are_required_and_complete_stop_rejects_exit_error(self):
        private = copy.deepcopy(self.proof)
        private['receipt']['effectIds'] = []
        with self.assertRaises(AssertionError): self.check(proof=private)
        public = copy.deepcopy(self.state)
        public['effects']['unresolvedCallIds'] = []
        with self.assertRaises(AssertionError): self.check(state=public)
        complete = copy.deepcopy(self.proof)
        complete['manifest'].update(sdkStopConfirmed=True, sealed=True)
        with self.assertRaises(AssertionError): self.check(503, 'exit_unconfirmed', proof=complete)

    def test_exact_identity_reservation_and_unknown_state_remain_required(self):
        for section, field, value in [(None, 'generation', 'other'), (None, 'sessionId', 'other'),
                (None, 'state', 'waiting_for_input'), (None, 'stopConfirmed', True), ('ref', 'id', 'other')]:
            state = copy.deepcopy(self.state)
            (state[section] if section else state)[field] = value
            with self.subTest(field=field), self.assertRaises(AssertionError): self.check(state=state)
        state = copy.deepcopy(self.state)
        state['ref']['provider']['installationId'] = 'other'
        with self.assertRaises(AssertionError): self.check(state=state)
        proof = copy.deepcopy(self.proof)
        proof['providerSession']['activeRun'] = None
        with self.assertRaises(AssertionError): self.check(proof=proof)

    def test_cached_snapshot_is_checked_only_after_bounded_fresh_reattachment(self):
        stale = {**copy.deepcopy(self.state), 'state': 'waiting_for_input', 'revision': '7',
            'messages': [{'text': 'never log private content'}]}
        old_unknown = {**copy.deepcopy(self.state), 'revision': '7'}
        values, seen, diagnostics = iter([stale, old_unknown, self.state]), [], []
        observations = [(409, 'effects_unconfirmed', copy.deepcopy(self.proof)) for _ in range(2)]
        for status, code, proof in observations:
            fixture._assert_private_crash_rejection(status, code, proof, self.target)
            with self.assertRaises(AssertionError):
                fixture._assert_crash_rejection(status, code, proof, stale, self.target)
        def wait(check, seconds):
            self.assertEqual(seconds, 30)
            for _ in range(3):
                value = check()
                seen.append(value)
                if value: return value
            raise TimeoutError('Projection was not fresh')
        fresh = fixture._wait_crash_projection(lambda: next(values), self.target, '8', wait, diagnostics.append)
        self.assertEqual(seen[:2], [None, None])
        self.assertEqual(fresh, self.state)
        for status, code, proof in observations:
            fixture._assert_crash_rejection(status, code, proof, fresh, self.target)
        self.assertEqual(len(diagnostics), 1)
        self.assertNotIn('never log private content', diagnostics[0])
        summary = json.loads(diagnostics[0].split(': ', 1)[1])
        self.assertEqual(summary['observed']['revision'], '8')

    def test_stale_projection_times_out_with_bounded_metadata_diagnostics(self):
        stale = {**copy.deepcopy(self.state), 'state': 'waiting_for_input', 'revision': '7',
            'messages': [{'text': 'private content'}]}
        diagnostics, checks = [], []
        def wait(check, seconds):
            self.assertEqual(seconds, 30)
            for _ in range(3): checks.append(check())
            raise TimeoutError('Projection was not fresh')
        with self.assertRaises(TimeoutError):
            fixture._wait_crash_projection(lambda: stale, self.target, '8', wait, diagnostics.append)
        self.assertEqual(checks, [None, None, None])
        self.assertEqual(len(diagnostics), 1)
        self.assertNotIn('private content', diagnostics[0])
        self.assertIn('waiting_for_input', diagnostics[0])

    def test_freshness_wait_does_not_hide_changed_identity_or_confirmed_stop(self):
        def once(check, seconds):
            self.assertEqual(seconds, 30)
            return check()
        for field, value in [('generation', 'other'), ('sessionId', 'other'), ('stopConfirmed', True)]:
            state = {**copy.deepcopy(self.state), field: value}
            with self.subTest(field=field), self.assertRaises(AssertionError):
                fixture._wait_crash_projection(lambda: state, self.target, '8', once, lambda _: None)
        state = copy.deepcopy(self.state)
        state['ref']['provider']['installationId'] = 'other'
        with self.assertRaises(AssertionError):
            fixture._wait_crash_projection(lambda: state, self.target, '8', once, lambda _: None)


if __name__ == '__main__':
    unittest.main()
