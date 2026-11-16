"""Fast contract tests for the opt-in real-clock managed acceptance orchestrator."""
import copy
import json
import pathlib
import unittest
from unittest.mock import patch
import importlib.util

spec = importlib.util.spec_from_file_location('provider_mcp_ttl_acceptance', pathlib.Path(__file__).with_name('provider_mcp_ttl_acceptance.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class Child:
    def __init__(self):
        self.now, self.running, self.generation = 0, True, 1
        self.resolved_at, self.commands, self.requests, self.messages = None, [], [], []
        self.reattached = False
        self.tool = {'server': 'target_test', 'alias': 'mcp_0123456789abcdef01234567'}
        self.event = {'type': 'approval_request', 'approvalId': 'agent-decision-'+json.dumps(['run-a', 'pending-a'], separators=(',', ':')).encode().hex(), 'toolName': 'target_test: list_apps'}
        self.binding = {'userId': 'user-a', 'providerAppId': 'unrelated.vendor-agent',
            'subject': {'kind': 'agent-run', 'id': 'run-a', 'revision': 'generation-a'},
            'correlationKey': 'run-a:pending-a', 'questions': [{'id': 'approval', 'question': self.event['toolName'],
                'options': [{'id': 'allow', 'label': 'Allow'}, {'id': 'deny', 'label': 'Deny'}], 'allowText': True}]}
        self.row = {'id': 'decision-a', 'userId': 'user-a', 'sourceAppId': self.binding['providerAppId'],
            'sourceInstallation': 'installation-a', 'state': 'pending', 'revision': 3,
            'input': {key: copy.deepcopy(self.binding[key]) for key in ('subject', 'correlationKey', 'questions')}}
        # Core may serialize default-valued optional fields omitted by the TS caller.
        self.row['input']['questions'][0].update(header=None, multiple=False)
        self.snapshot = {'ref': {'id': 'run-a', 'provider': {'appId': self.binding['providerAppId'], 'installationId': 'installation-a', 'key': 'agent'}},
            'sessionId': 'session-a', 'generation': 'generation-a', 'configurationRevision': 'config-a', 'freshness': 'current', 'stopConfirmed': False,
            'pending': [{'id': 'pending-a', 'kind': 'approval', 'delivery': 'continue_run', 'toolName': self.event['toolName']}]}
        core_apps = {'apps': [{'id': 'unrelated.consumer', 'runtimeState': 'stopped'},
            {'id': self.binding['providerAppId'], 'runtimeState': 'running'}]}
        self.model_requests = [{'messages': [{'role': 'tool', 'tool_name': self.tool['alias'],
            'content': json.dumps({'status': 'completed', 'output': json.dumps(core_apps), 'truncated': False})}]}]
        self.context = {'managed': True, 'child_id': 'child-a', 'harnessAppId': 'unrelated.consumer',
            'agentProviders': type('Providers', (), {'entries': {'ollama': {'appId': self.binding['providerAppId']}}})(),
            'request': self.request, 'say': self.messages.append, 'run': self.run,
            'cli': '/test/hosty', 'root': '/test/child', 'harnessRuntimeIdentity': lambda: (None, self.generation)}

    def request(self, route, body=None):
        self.requests.append((self.now, route, copy.deepcopy(body), self.running))
        if route == '/api/auth/session':
            return {'user': {'id': 'user-a'}}
        if route.startswith('/api/decisions/v1/requests?'):
            return {'items': [copy.deepcopy(self.row)], 'cursor': None}
        if route == '/api/apps':
            return {'apps': [{'id': 'unrelated.consumer', 'runtimeState': 'running' if self.running else 'stopped'}]}
        if route.endswith('/health'):
            return {'status': 'healthy', 'services': [{'service': 'api', 'processId': 111, 'startedAt': 'provider-start-a'}]}
        if route.endswith('/resolve'):
            if self.resolved_at is None:
                self.resolved_at = self.now
                self.command = copy.deepcopy(body)
                # Core binds a typed HostyDecisionAnswer, which writes optional Text as null.
                canonical = {key: {**answer, 'text': answer.get('text')} for key, answer in copy.deepcopy(body['answers']).items()}
                self.row.update(state='answered', revision=4, resolution={'userId': 'user-a', 'answers': canonical},
                    delivery={'receivedAt': 'received'}, continuation={'state': 'completed'})
                self.receipt = copy.deepcopy(self.row)
            assert body == self.command
            return copy.deepcopy(self.receipt)
        if route.endswith('/decision-a'):
            return copy.deepcopy(self.row)
        raise AssertionError('Unexpected fixture API route: ' + route)

    def call(self, origin, route, body=None):
        assert self.running
        if route == '/api/sessions/chat-a/credentials':
            assert self.generation == 2 and body == {}
            self.reattached = True
            return {'updated': True}
        assert route == '/api/sessions/chat-a' and body is None
        return {'providerExecution': {'run': copy.deepcopy(self.snapshot)}}

    def run(self, argv):
        assert argv == ['/test/hosty', '--data-root', '/test/child', 'apps', 'stop', 'unrelated.consumer']
        self.commands.append(argv)
        self.running = False

    def timed(self, action):
        assert action == 'start' and not self.running
        self.commands.append(action)
        self.running, self.generation = True, self.generation + 1

    def sleep(self, seconds):
        self.now += seconds

    def execute(self):
        with patch.object(fixture.time, 'monotonic', side_effect=lambda: self.now), patch.object(fixture.time, 'sleep', side_effect=self.sleep):
            return fixture.hold_core_approval(self.context, 'http://child-app', self.call, self.timed,
                'chat-a', self.event, self.tool, self.model_requests, copy.deepcopy(self.snapshot))


class McpTtlAcceptanceTests(unittest.TestCase):
    def test_canonical_null_answer_retains_original_request_and_resolution(self):
        child = Child()
        child.execute()
        self.assertEqual(child.receipt['resolution']['answers'], {'approval': {'optionIds': ['allow'], 'text': None}})
        self.assertEqual(child.command['answers'], {'approval': {'optionIds': ['allow']}})
        fixture._assert_allow_answer({'approval': {'optionIds': ['allow']}})

    def test_wrong_or_additional_options_are_not_allow_approval(self):
        for options in [['deny'], ['allow', 'deny'], ['allow', 'allow'], [], None, 'allow']:
            with self.subTest(options=options), self.assertRaises(AssertionError):
                fixture._assert_allow_answer({'approval': {'optionIds': options, 'text': None}})

    def test_extra_text_or_unsupported_answer_fields_are_rejected(self):
        for answer in [{'optionIds': ['allow'], 'text': 'unexpected text'}, {'optionIds': ['allow'], 'text': ''},
                {'optionIds': ['allow'], 'text': None, 'foreignField': True}]:
            with self.subTest(answer=answer), self.assertRaises(AssertionError):
                fixture._assert_allow_answer({'approval': answer})

    def test_foreign_or_extra_answer_keys_are_rejected(self):
        for answers in [{'foreign-question': {'optionIds': ['allow']}},
                {'approval': {'optionIds': ['allow']}, 'foreign-question': {'optionIds': ['deny']}}, {}]:
            with self.subTest(keys=list(answers)), self.assertRaises(AssertionError):
                fixture._assert_allow_answer(answers)

    def test_finished_resolution_must_remain_the_canonical_resolved_response(self):
        child = Child()
        request = child.request
        def changed(route, body=None):
            result = request(route, body)
            if child.resolved_at is not None and route.endswith('/decision-a'):
                result['resolution']['userId'] = 'foreign-actor'
            return result
        child.context['request'] = changed
        with self.assertRaisesRegex(AssertionError, 'canonical Core resolution changed'):
            child.execute()
        self.assertTrue(child.running)

    def test_real_duration_and_same_actor_resolution_complete_before_consumer_restart(self):
        child = Child()
        result = child.execute()
        self.assertEqual(child.resolved_at, 310)
        self.assertEqual(result, {'runId': 'run-a', 'generation': 'generation-a', 'configurationRevision': 'config-a', 'decisionId': 'decision-a'})
        resolves = [row for row in child.requests if row[1].endswith('/resolve')]
        self.assertEqual(len(resolves), 2)
        self.assertEqual(resolves[0][2], resolves[1][2])
        self.assertTrue(all(not row[3] for row in resolves))
        self.assertEqual(child.commands[-1], 'start')
        self.assertTrue(child.running)
        self.assertTrue(child.reattached)

    def test_only_managed_child_is_eligible(self):
        child = Child()
        child.context['managed'] = False
        with self.assertRaisesRegex(AssertionError, 'disposable managed child'):
            child.execute()
        self.assertEqual(child.commands, [])

    def test_original_snapshot_is_not_reselected_from_later_consumer_state(self):
        child = Child()
        call = child.call
        def no_reselection(origin, route, body=None):
            self.assertNotEqual(route, '/api/sessions/chat-a')
            return call(origin, route, body)
        child.call = no_reselection
        self.assertEqual(child.execute()['runId'], 'run-a')

    def test_core_decision_requires_original_provider_installation(self):
        child = Child()
        child.snapshot['ref']['provider']['installationId'] = 'replacement-installation'
        with self.assertRaisesRegex(AssertionError, 'original provider installation'):
            child.execute()
        self.assertEqual(child.commands, [])

    def test_equivalent_core_json_installation_timestamp_retains_original_identity(self):
        child = Child()
        child.row['sourceInstallation'] = '2026-11-13T12:00:00.686361+00:00'
        child.snapshot['ref']['provider']['installationId'] = '2026-11-13T12:00:00.6863610+00:00'
        self.assertEqual(child.execute()['runId'], 'run-a')

    def test_one_tick_installation_difference_is_rejected_before_stopping(self):
        child = Child()
        child.row['sourceInstallation'] = '2026-11-13T12:00:00.686361+00:00'
        child.snapshot['ref']['provider']['installationId'] = '2026-11-13T12:00:00.6863611+00:00'
        with self.assertRaisesRegex(AssertionError, 'original provider installation'):
            child.execute()
        self.assertEqual(child.commands, [])

    def test_installation_timestamp_normalization_is_exact_not_microsecond_truncation(self):
        self.assertTrue(fixture._same_installation('2026-11-13T12:00:00.100Z', '2026-11-13T13:00:00.1000000+01:00'))
        self.assertFalse(fixture._same_installation('2026-11-13T12:00:00.1000001Z', '2026-11-13T12:00:00.1000002+00:00'))
        self.assertFalse(fixture._same_installation(None, None))

    def test_exact_actor_provider_generation_and_question_are_required(self):
        child = Child()
        self.assertTrue(fixture._same_decision(child.row, child.binding))
        for section, key, value in [(None, 'userId', 'other-user'), (None, 'sourceAppId', 'other-provider'),
                ('subject', 'revision', 'other-generation')]:
            row = copy.deepcopy(child.row)
            (row['input'][section] if section else row)[key] = value
            self.assertFalse(fixture._same_decision(row, child.binding))
        child.row['input']['questions'][0]['options'][0]['id'] = 'different-allow'
        self.assertFalse(fixture._same_decision(child.row, child.binding))

    def test_duplicate_exact_decisions_are_rejected_before_stopping(self):
        child = Child()
        request = child.request
        def duplicate(route, body=None):
            result = request(route, body)
            if route.startswith('/api/decisions/v1/requests?'):
                result['items'] *= 2
            return result
        child.context['request'] = duplicate
        with self.assertRaisesRegex(AssertionError, 'one Core Decision'):
            child.execute()
        self.assertEqual(child.commands, [])

    def test_changed_pending_decision_aborts_without_resolving_and_restores_consumer(self):
        child = Child()
        sleep = child.sleep
        def change(seconds):
            sleep(seconds)
            child.row['revision'] += 1
        child.sleep = change
        with self.assertRaisesRegex(AssertionError, 'remain pending'):
            child.execute()
        self.assertIsNone(child.resolved_at)
        self.assertTrue(child.running)

    def test_healthy_status_does_not_hide_provider_restart(self):
        child = Child()
        request = child.request
        def restarted(route, body=None):
            result = request(route, body)
            if not child.running and route.endswith('/health'):
                result['services'][0]['processId'] += 1
            return result
        child.context['request'] = restarted
        with self.assertRaisesRegex(AssertionError, 'provider must not restart'):
            child.execute()
        self.assertIsNone(child.resolved_at)
        self.assertTrue(child.running)

    def test_core_output_must_prove_dispatch_while_harness_is_stopped(self):
        child = Child()
        fixture.assert_core_dispatch(child.model_requests, child.tool, 'unrelated.consumer', 'unrelated.vendor-agent')
        receipt = json.loads(child.model_requests[0]['messages'][0]['content'])
        data = json.loads(receipt['output'])
        data['apps'][0]['runtimeState'] = 'running'
        receipt['output'] = json.dumps(data)
        child.model_requests[0]['messages'][0]['content'] = json.dumps(receipt)
        with self.assertRaisesRegex(AssertionError, 'while Harness is stopped'):
            child.execute()
        self.assertTrue(child.running)

    def test_failed_or_truncated_tool_receipt_is_not_dispatch_proof(self):
        for field, value in [('status', 'failed'), ('truncated', True)]:
            child = Child()
            receipt = json.loads(child.model_requests[0]['messages'][0]['content'])
            receipt[field] = value
            child.model_requests[0]['messages'][0]['content'] = json.dumps(receipt)
            with self.assertRaisesRegex(AssertionError, 'complete, successful result'):
                fixture.assert_core_dispatch(child.model_requests, child.tool, 'unrelated.consumer', 'unrelated.vendor-agent')


if __name__ == '__main__':
    unittest.main()
