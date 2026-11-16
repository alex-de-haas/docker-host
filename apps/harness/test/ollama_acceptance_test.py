"""Fast exact-binding checks for the managed Ollama question projection wait."""
import copy
import importlib.util
import json
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('ollama_acceptance', pathlib.Path(__file__).with_name('ollama_acceptance.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class QuestionProjectionTests(unittest.TestCase):
    def setUp(self):
        self.expected = {'ref': {'id': 'run-a', 'provider': {'appId': 'unrelated.provider',
            'installationId': 'installation-a', 'key': 'agent'}}, 'sessionId': 'session-a',
            'generation': 'generation-a', 'configurationRevision': 'config-a'}
        self.pending = {'id': 'question-a', 'revision': '3', 'kind': 'question', 'delivery': 'continue_run',
            'questions': [{'id': 'choice', 'text': 'Private fixture question', 'allowText': True,
                'options': [{'id': 'quick', 'label': 'Private choice'}, {'id': 'full', 'label': 'Full'}]}]}
        self.state = {**copy.deepcopy(self.expected), 'revision': '5', 'state': 'waiting_for_input',
            'phase': 'waiting', 'freshness': 'current', 'stopConfirmed': False, 'pending': [self.pending]}
        card = 'agent-decision-'+json.dumps(['run-a', 'question-a'], separators=(',', ':')).encode().hex()
        self.event = {'type': 'question_request', 'questionId': card, 'providerGeneration': 'generation-a',
            'providerEventId': 'run-a:decision:question-a:3', 'questions': [{'id': 'choice',
                'question': 'Private fixture question', 'header': 'Question', 'allowText': True, 'multiSelect': False,
                'options': [{'id': 'quick', 'label': 'Private choice', 'description': ''},
                    {'id': 'full', 'label': 'Full', 'description': ''}]}]}
        self.diagnostics, self.checks = [], 0

    def wait(self, check, seconds):
        self.assertEqual(seconds, 30)
        for _ in range(3):
            self.checks += 1
            result = check()
            if result: return result
        raise TimeoutError('Exact pending question did not appear')

    def observe(self, read=None):
        return fixture._wait_pending_question(read or (lambda: self.state), self.expected,
            self.event, self.wait, self.diagnostics.append)

    def test_sse_can_precede_pending_rest_projection(self):
        stale = {**copy.deepcopy(self.state), 'pending': [], 'state': 'running'}
        values = iter([stale, self.state])
        observed, pending = self.observe(lambda: next(values))
        self.assertEqual(observed, self.state)
        self.assertEqual(pending, self.pending)
        self.assertEqual(self.checks, 2)
        self.assertEqual(len(self.diagnostics), 1)
        self.assertNotIn('Private fixture question', self.diagnostics[0])
        self.assertNotIn('Private choice', self.diagnostics[0])

    def test_foreign_run_provider_session_generation_or_configuration_fails_immediately(self):
        for field in ['sessionId', 'generation', 'configurationRevision']:
            state = {**copy.deepcopy(self.state), field: 'foreign'}
            with self.subTest(field=field), self.assertRaises(AssertionError):
                self.observe(lambda: state)
        for field in ['id', 'provider']:
            state = copy.deepcopy(self.state)
            state['ref'][field] = 'foreign' if field == 'id' else {**state['ref']['provider'], 'installationId': 'foreign'}
            with self.subTest(field=field), self.assertRaises(AssertionError):
                self.observe(lambda: state)
        self.assertEqual(self.checks, 5)

    def test_terminal_or_unknown_execution_fails_without_waiting(self):
        for value in ['succeeded', 'failed', 'cancelled', 'unknown']:
            state = {**copy.deepcopy(self.state), 'state': value, 'pending': []}
            with self.subTest(state=value), self.assertRaises(AssertionError):
                self.observe(lambda: state)
        self.state['stopConfirmed'] = True
        with self.assertRaises(AssertionError): self.observe()
        self.assertEqual(self.checks, 5)

    def test_missing_exact_row_times_out_instead_of_accepting_another_question(self):
        self.state['pending'][0]['id'] = 'another-question'
        with self.assertRaises(TimeoutError): self.observe()
        self.assertEqual(self.checks, 3)
        self.assertEqual(len(self.diagnostics), 1)
        self.assertNotIn('Private fixture question', self.diagnostics[0])

    def test_changed_question_or_option_identity_is_rejected(self):
        for field in ['id', 'text']:
            state = copy.deepcopy(self.state)
            state['pending'][0]['questions'][0][field] = 'changed'
            with self.subTest(field=field), self.assertRaises(AssertionError):
                self.observe(lambda: state)
        state = copy.deepcopy(self.state)
        state['pending'][0]['questions'][0]['options'][0]['id'] = 'different-option'
        with self.assertRaises(AssertionError): self.observe(lambda: state)

    def test_qualified_card_and_event_generation_must_match_original_run(self):
        original = copy.deepcopy(self.event)
        for field, value in [('questionId', 'unqualified'), ('providerGeneration', 'foreign')]:
            self.event = {**copy.deepcopy(original), field: value}
            with self.subTest(field=field), self.assertRaises(AssertionError): self.observe()
        self.assertEqual(self.checks, 0)

    def test_exact_pending_revision_and_delivery_remain_required(self):
        for field, value in [('revision', '4'), ('delivery', 'next_turn')]:
            state = copy.deepcopy(self.state)
            state['pending'][0][field] = value
            with self.subTest(field=field), self.assertRaises(AssertionError):
                self.observe(lambda: state)

    def test_duplicate_exact_pending_questions_fail_closed(self):
        self.state['pending'] *= 2
        with self.assertRaises(AssertionError): self.observe()


class ApprovalProjectionTests(unittest.TestCase):
    def setUp(self):
        self.expected = {'ref': {'id': 'run-a', 'provider': {'appId': 'unrelated.provider',
            'installationId': 'installation-a', 'key': 'agent'}}, 'sessionId': 'session-a',
            'generation': 'generation-a', 'configurationRevision': 'config-a'}
        self.pending = {'id': 'approval-a', 'revision': '2', 'kind': 'approval', 'delivery': 'continue_run',
            'toolName': 'target-a: list_apps', 'input': {}}
        self.state = {**copy.deepcopy(self.expected), 'revision': '5', 'state': 'waiting_for_input',
            'phase': 'waiting', 'freshness': 'current', 'stopConfirmed': False, 'pending': [self.pending]}
        self.event = {'type': 'approval_request', 'approvalId': 'agent-decision-'+json.dumps(['run-a', 'approval-a'], separators=(',', ':')).encode().hex(),
            'providerGeneration': 'generation-a', 'providerEventId': 'run-a:decision:approval-a:2',
            'toolName': 'target-a: list_apps', 'input': {}}
        self.tool = {'server': 'target-a', 'alias': 'mcp_0123456789abcdef01234567'}
        self.diagnostics, self.checks = [], 0

    def wait(self, check, seconds):
        self.assertEqual(seconds, 30)
        for _ in range(3):
            self.checks += 1
            result = check()
            if result: return result
        raise TimeoutError('Exact pending approval did not appear')

    def observe(self, read=None):
        return fixture._wait_pending_approval(read or (lambda: self.state), self.expected,
            self.event, self.tool, self.wait, self.diagnostics.append)

    def test_delayed_approval_uses_original_binding_and_exact_pending_identity(self):
        original = copy.deepcopy(self.expected)
        stale = {**copy.deepcopy(self.state), 'pending': [], 'state': 'running'}
        values = iter([stale, self.state])
        self.assertEqual(self.observe(lambda: next(values)), self.state)
        self.assertEqual(self.expected, original)
        self.assertEqual(self.checks, 2)
        self.assertEqual(len(self.diagnostics), 1)
        self.assertNotIn('input', json.loads(self.diagnostics[0].split(': ', 1)[1]))

    def test_foreign_run_or_installation_is_not_repinned(self):
        for field in ['id', 'provider']:
            state = copy.deepcopy(self.state)
            state['ref'][field] = 'foreign' if field == 'id' else {**state['ref']['provider'], 'installationId': 'foreign'}
            with self.subTest(field=field), self.assertRaises(AssertionError):
                self.observe(lambda: state)
        self.assertEqual(self.checks, 2)

    def test_missing_exact_approval_times_out_without_accepting_same_named_tool(self):
        self.state['pending'][0]['id'] = 'another-approval'
        with self.assertRaises(TimeoutError): self.observe()
        self.assertEqual(self.checks, 3)
        self.assertEqual(len(self.diagnostics), 1)

    def test_terminal_or_confirmed_exit_fails_immediately(self):
        for state in [{**copy.deepcopy(self.state), 'state': 'failed'},
                {**copy.deepcopy(self.state), 'state': 'unknown'}, {**copy.deepcopy(self.state), 'stopConfirmed': True}]:
            with self.assertRaises(AssertionError): self.observe(lambda: state)
        self.assertEqual(self.checks, 3)

    def test_changed_tool_arguments_title_revision_or_delivery_is_rejected(self):
        for field, value in [('toolName', 'target-b: list_apps'), ('input', {'changed': 'private argument'}),
                ('title', 'Changed request'), ('revision', '3'), ('delivery', 'next_turn')]:
            state = copy.deepcopy(self.state)
            state['pending'][0][field] = value
            with self.subTest(field=field), self.assertRaises(AssertionError):
                self.observe(lambda: state)
        self.assertNotIn('private argument', ''.join(self.diagnostics))


class ContextObservationTests(unittest.TestCase):
    def setUp(self):
        self.mcp = {'type': 'function', 'function': {'name': 'mcp_fixture',
            'description': 'mcp__target_test__list_apps — List installed applications',
            'parameters': {'type': 'object', 'properties': {}}}}
        local = {'type': 'function', 'function': {'name': 'read_file', 'parameters': {}}}
        self.requests = [{'messages': [{'role': 'system', 'content': 'You are a coding assistant in Hosty. Fixture'}],
            'tools': [copy.deepcopy(local)] + ([copy.deepcopy(self.mcp)] if index else [])} for index in range(3)]
        tokens = (len(json.dumps(self.mcp, separators=(',', ':'), ensure_ascii=False).encode()) + 3) // 4
        self.observations = [{'usedTokens': 101 + index, 'maxTokens': 32768, 'estimated': False,
            'observedAt': '2026-11-13T12:00:00Z', 'mcp': {'version': 1, 'method': 'local-estimate',
                'estimator': 'utf8-json-div4-v1', 'omittedTools': 0, 'tools': [{'server': 'target_test',
                    'name': 'list_apps', 'tokens': tokens, 'inclusion': 'loaded' if index else 'available'}]}}
            for index in range(3)]

    def test_latest_snapshot_can_skip_offline_intermediate_context_without_claiming_a_full_ledger(self):
        fixture._assert_context_observations([self.observations[0], self.observations[2]], self.requests, latest=True)
        with self.assertRaisesRegex(AssertionError, 'Every online ordinary step'):
            fixture._assert_context_observations([self.observations[0], self.observations[2]], self.requests, complete_ledger=True)
        fixture._assert_context_observations(self.observations, self.requests, complete_ledger=True, latest=True)

    def test_latest_context_must_name_the_actual_last_ordinary_response(self):
        with self.assertRaisesRegex(AssertionError, 'latest ordinary context'):
            fixture._assert_context_observations(self.observations[:2], self.requests, latest=True)
        fixture._assert_context_observations([self.observations[-1]], self.requests, latest=True)

    def test_duplicate_reversed_unknown_or_non_integer_response_id_is_not_count_tolerance(self):
        cases = [[self.observations[0], self.observations[0]], list(reversed(self.observations))]
        cases += [[{**self.observations[0], 'usedTokens': count}] for count in (100, 104, True, 101.5)]
        for values in cases:
            with self.subTest(values=values), self.assertRaises(AssertionError):
                fixture._assert_context_observations(values, self.requests)

    def test_each_observed_loaded_definition_token_count_and_inclusion_matches_exact_request(self):
        for field, value in [('tokens', 999), ('inclusion', 'available'), ('name', 'foreign_tool')]:
            observed = copy.deepcopy(self.observations[-1])
            observed['mcp']['tools'][0][field] = value
            with self.subTest(field=field), self.assertRaises(AssertionError):
                fixture._assert_context_observations([observed], self.requests)
        for field, value in [('maxTokens', 999), ('estimated', True)]:
            with self.subTest(field=field), self.assertRaises(AssertionError):
                fixture._assert_context_observations([{**self.observations[-1], field: value}], self.requests)

    def test_unknown_compaction_or_auxiliary_model_request_is_not_ordinary_accounting(self):
        for patch in [{'tools': []}, {'messages': [{'role': 'system', 'content': 'Summarize conversation data'}]}]:
            requests = copy.deepcopy(self.requests)
            requests[1].update(patch)
            with self.subTest(patch=patch), self.assertRaisesRegex(AssertionError, 'non-ordinary'):
                fixture._assert_context_observations(self.observations, requests)


if __name__ == '__main__':
    unittest.main()
