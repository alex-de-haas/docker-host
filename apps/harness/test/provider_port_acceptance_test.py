"""Fast negative controls for the managed provider-port acceptance proof."""
import copy
import io
import json
import os
import pathlib
import socket
import tempfile
import unittest

import provider_port_acceptance as fixture


class ProviderPortChecks(unittest.TestCase):
    def setUp(self):
        self.provider = {'appId': 'unrelated.agent', 'installationId': 'opaque-installation', 'key': 'coding'}
        self.connection = {'id': 'qualified-account', 'revision': '7', 'kind': 'agent', 'available': True,
            'provider': {**self.provider, 'name': 'An independently installed agent'}}
        self.plan = {'appId': self.provider['appId'], 'service': 'server', 'portKey': 'api', 'currentPort': 23451,
            'currentUrl': 'http://127.0.0.1:23451', 'ownerRunning': True, 'affectedDependents': []}
        self.result = {'appId': self.provider['appId'], 'service': 'server', 'portKey': 'api', 'oldPort': 23451,
            'newPort': 23452, 'newUrl': 'http://localhost:23452', 'restartRequiredAppIds': [self.provider['appId']]}
        self.run = {'ref': {'provider': self.provider, 'id': 'run-one'}, 'sessionId': 'public-session',
            'freshness': 'current', 'state': 'succeeded', 'stopConfirmed': True,
            'effects': {'certainty': 'known', 'unresolvedCallIds': []}, 'pending': []}

    def transition(self, plan=None, result=None):
        fixture._assert_port_change(self.plan if plan is None else plan, self.result if result is None else result,
            self.provider['appId'], 'server', 'api', 'http://localhost:23451')

    def test_exact_provider_assignment_moves_only_its_owner(self):
        self.transition()
        fixture._completed(self.run, self.provider, 'public-session')
        self.assertEqual(fixture._selection(self.connection),
            {'id': 'qualified-account', 'revision': '7', 'provider': self.provider})

    def test_wrong_assignment_stale_endpoint_or_same_port_fails(self):
        for field, value in [('appId', 'foreign'), ('service', 'foreign'), ('portKey', 'foreign'),
                ('oldPort', 23450), ('newPort', 23451), ('newUrl', 'http://localhost:23453'),
                ('restartRequiredAppIds', [self.provider['appId'], 'consumer'])]:
            with self.subTest(field=field), self.assertRaises(AssertionError):
                self.transition(result={**self.result, field: value})
        for patch in [{'ownerRunning': False}, {'affectedDependents': [{'appId': 'consumer', 'running': True}]},
                {'currentUrl': 'http://localhost:23450'}]:
            with self.subTest(patch=patch), self.assertRaises(AssertionError):
                self.transition(plan={**self.plan, **patch})

    def test_child_identity_does_not_authorize_an_ordinary_instance(self):
        context = {'managed': True, 'child_id': 'owned-child', 'child': {'id': 'owned-child', 'state': 'running',
            'dataRoot': '/private/tmp/test-owned-child', 'port': 23450}, 'root': '/private/tmp/test-owned-child',
            'parent': ('/private/tmp/test-parent',), 'origin': 'http://localhost:23450'}
        self.assertEqual(fixture._owned_child(context), pathlib.Path(context['root']))
        for patch in [{'managed': False}, {'child_id': 'other'}, {'root': '/private/tmp/test-parent'},
                {'parent': (context['root'],)}, {'origin': 'http://localhost:23451'},
                {'origin': 'http://remote.example:23450'}]:
            with self.subTest(patch=patch), self.assertRaises(AssertionError):
                fixture._owned_child({**context, **patch})

    def test_uncertainty_cannot_be_used_as_quiescent_restart_proof(self):
        for patch in [{'stopConfirmed': False}, {'freshness': 'stale'}, {'state': 'unknown'},
                {'effects': {'certainty': 'unknown', 'unresolvedCallIds': []}},
                {'effects': {'certainty': 'known', 'unresolvedCallIds': ['pending-effect']}},
                {'pending': [{'id': 'approval'}]}, {'pendingContinuations': [{'state': 'pending'}]},
                {'sessionId': 'foreign'}]:
            with self.subTest(patch=patch), self.assertRaises(AssertionError):
                fixture._completed({**self.run, **patch}, self.provider, 'public-session')
        with self.assertRaises(AssertionError): fixture._completed(self.run, {**self.provider, 'installationId': 'other'})

    def test_current_core_pid_and_actual_tcp_listener_are_required(self):
        self.assertTrue(fixture._alive(os.getpid()))
        self.assertEqual(fixture._identity({'services': [{'service': 'server', 'processId': os.getpid(),
            'startedAt': 'actual-start'}]}, 'server'), (os.getpid(), 'actual-start'))
        self.assertEqual(fixture._identity({'services': [{'service': 'server', 'processId': os.getpid()}]},
            'server'), (os.getpid(), None))  # Actual Core Local health has no start timestamp.
        for row in [{'processId': None, 'startedAt': 'old'}, {'processId': True, 'startedAt': 'old'},
                {'processId': 0, 'startedAt': 'old'}]:
            with self.subTest(row=row), self.assertRaises(AssertionError):
                fixture._identity({'services': [{'service': 'server', **row}]}, 'server')
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0)); listener.listen()
            url = 'http://127.0.0.1:'+str(listener.getsockname()[1])
            self.assertTrue(fixture._tcp_open(url))
        self.assertFalse(fixture._tcp_open(url))
        for url in ['http://remote.example:23452', 'https://localhost:23452', 'http://user:secret@localhost:23452']:
            with self.subTest(url=url), self.assertRaises(AssertionError): fixture._listener(url)

    def test_browser_alias_must_match_core_but_tcp_uses_its_raw_loopback_endpoint(self):
        alias = 'http://aunrelated-dagentz.i-child.hosty.localhost:23452'
        endpoint = {'url': 'http://127.0.0.1:23452', 'browserOrigin': alias}
        self.assertEqual(fixture._bound_listener(alias, endpoint), endpoint['url'])
        self.assertEqual(fixture._bound_listener('http://localhost:23452', {'url': 'http://localhost:23452'}),
            'http://localhost:23452')
        for origin in ['http://other.i-child.hosty.localhost:23452', alias.replace('23452', '23453'),
                'http://remote.example:23452', alias+'/settings', alias+'?token=private']:
            with self.subTest(origin=origin), self.assertRaises(AssertionError):
                fixture._bound_listener(origin, endpoint)
        for value in [{'url': 'http://remote.example:23452', 'browserOrigin': alias},
                {'url': endpoint['url'], 'browserOrigin': 'http://remote.example:23452'}]:
            with self.subTest(endpoint=value), self.assertRaises(AssertionError):
                fixture._bound_listener(value['browserOrigin'], value)
        with self.assertRaises(AssertionError): fixture._listener(alias)

    def test_native_binding_is_exact_child_session_owner_and_installation(self):
        with tempfile.TemporaryDirectory(prefix='hosty-provider-port-test-') as temporary:
            root = pathlib.Path(temporary).resolve()
            path = root/'apps'/self.provider['appId']/'data/agent-sessions/public-session.json'
            path.parent.mkdir(parents=True)
            value = {'id': 'public-session', 'session': {'ref': {'provider': self.provider, 'id': 'public-session'}, 'nativeState': 'available'},
                'owner': {'callerAppId': 'independent-consumer', 'userId': 'test-user'}, 'nativeId': 'native-context'}
            path.write_text(json.dumps(value))
            self.assertEqual(fixture._native_binding(root, self.provider, self.run, 'independent-consumer', 'test-user'), 'native-context')
            for target, key, replacement in [('owner', 'userId', 'other'), ('owner', 'callerAppId', 'other'),
                    (None, 'id', 'foreign'), ('session', 'nativeState', 'unavailable'), (None, 'nativeId', None)]:
                changed = copy.deepcopy(value)
                (changed[target] if target else changed)[key] = replacement
                path.write_text(json.dumps(changed))
                with self.subTest(key=key), self.assertRaises(AssertionError):
                    fixture._native_binding(root, self.provider, self.run, 'independent-consumer', 'test-user')
            changed = copy.deepcopy(value)
            changed['session']['ref']['provider']['installationId'] = 'other-installation'
            path.write_text(json.dumps(changed))
            with self.assertRaises(AssertionError):
                fixture._native_binding(root, self.provider, self.run, 'independent-consumer', 'test-user')

    def test_authenticated_sse_requires_a_terminal_and_rejects_new_native_work(self):
        class Response(io.BytesIO):
            status = 200
            headers = {'Content-Type': 'text/event-stream; charset=utf-8'}
        class Client:
            def __init__(self, events): self.events = events
            def open(self, url, timeout):
                return Response(b''.join(b'data: '+json.dumps({'event': event}).encode()+b'\n\n' for event in self.events))
        events = [{'type': 'assistant_text', 'text': 'hello'}, {'type': 'result', 'status': 'success'}]
        self.assertEqual(fixture._read_result(Client(events), 'http://consumer/events'), events)
        for events in [[{'type': 'error'}], [{'type': 'approval_request'}], [{'type': 'question_request'}],
                [{'type': 'assistant_text', 'text': 'no terminal'}]]:
            with self.subTest(events=events), self.assertRaises(AssertionError):
                fixture._read_result(Client(events), 'http://consumer/events')


if __name__ == '__main__':
    unittest.main()
