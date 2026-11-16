"""Real five-minute MCP grant renewal with its consuming Harness stopped.

Only the opt-in managed-child acceptance calls this helper. The fixture clock is never
passed to production: its 310-second wait exceeds CoreAgentMcp's real five-minute TTL.
"""
import json
import re
import time
import urllib.parse
import uuid
from datetime import date

MCP_TTL_WAIT_SECONDS = 310


def _assert_allow_answer(answers):
    # HostyDecisionAnswer serializes omitted optional Text as JSON null. Its exact
    # canonical response remains distinct from the original immutable request bytes.
    assert isinstance(answers, dict) and set(answers) == {'approval'}, 'The Core resolution must answer exactly the original approval question'
    answer = answers['approval']
    assert isinstance(answer, dict) and set(answer) <= {'optionIds', 'text'}, 'The Core approval answer contains unsupported fields'
    assert answer.get('optionIds') == ['allow'] and answer.get('text') is None, 'The Core approval must select only allow with no text'


def _same_installation(actual, expected):
    """Core's timestamp installation reference retains all seven fractional digits.

    DateTimeOffset JSON trims trailing zeros. Compare exact 100 ns ticks rather
    than Python datetime's six-digit microseconds; opaque identical IDs stay exact.
    """
    if isinstance(actual, str) and actual and actual == expected:
        return True
    def ticks(value):
        if not isinstance(value, str): return None
        match = re.fullmatch(r'([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,7}))?(Z|[+-][0-9]{2}:[0-9]{2})', value)
        if not match: return None
        year, month, day, hour, minute, second = map(int, match.groups()[:6])
        if hour > 23 or minute > 59 or second > 59: return None
        try: ordinal = date(year, month, day).toordinal()
        except ValueError: return None
        zone = match[8]
        offset = 0
        if zone != 'Z':
            hours, minutes = int(zone[1:3]), int(zone[4:6])
            if hours > 14 or minutes > 59 or hours == 14 and minutes: return None
            offset = (hours * 3600 + minutes * 60) * (1 if zone[0] == '+' else -1)
        seconds = ordinal * 86400 + hour * 3600 + minute * 60 + second - offset
        return seconds * 10000000 + int((match[7] or '').ljust(7, '0'))
    left, right = ticks(actual), ticks(expected)
    return left is not None and left == right


def matches_core_approval(event, tool):
    return (event.get('type') == 'approval_request' and bool(tool)
            and event.get('toolName') == tool['server'] + ': list_apps')


def _same_decision(row, binding):
    value = row.get('input') or {}
    return (row.get('userId') == binding['userId']
            and row.get('sourceAppId') == binding['providerAppId']
            and value.get('subject') == binding['subject']
            and value.get('correlationKey') == binding['correlationKey']
            and _same_questions(value.get('questions'), binding['questions']))


def _same_questions(actual, expected):
    if not isinstance(actual, list) or len(actual) != len(expected):
        return False
    for question, selected in zip(actual, expected):
        if (question.get('id') != selected['id'] or question.get('question') != selected['question']
                or question.get('allowText') is not True or question.get('multiple', False)
                or [(option.get('id'), option.get('label')) for option in question.get('options') or []]
                != [(option['id'], option['label']) for option in selected['options']]):
            return False
    return True


def _pending_decision(request, binding):
    query = {'state': 'pending', 'subject': binding['subject']['id'], 'limit': 100}
    matches, cursors = [], set()
    while True:
        page = request('/api/decisions/v1/requests?' + urllib.parse.urlencode(query))
        matches.extend(row for row in page['items'] if _same_decision(row, binding))
        cursor = page.get('cursor')
        if not cursor:
            break
        assert cursor not in cursors, 'Core Decisions pagination repeated a cursor'
        cursors.add(cursor)
        query['cursor'] = cursor
    assert len(matches) <= 1, 'The exact provider approval must identify one Core Decision'
    return matches[0] if matches else None


def _wait(check, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(1)
    raise AssertionError('Timed out waiting for the exact provider-owned Core Decision')


def hold_core_approval(context, app_origin, call, timed, session_id, event, tool, model_requests, original):
    """Resolve the original Core Decision after TTL; never invoke through stopped Harness."""
    assert context.get('managed') and context.get('child_id'), 'MCP TTL acceptance requires a disposable managed child Core'
    assert matches_core_approval(event, tool), 'Only the configured safe Core list_apps approval may be held'
    request, say = context['request'], context['say']
    app_id = context['harnessAppId']
    provider_id = context['agentProviders'].entries['ollama']['appId']
    assert original['ref']['provider']['appId'] == provider_id, 'The held approval must retain its original selected provider'
    assert original['freshness'] == 'current' and original['stopConfirmed'] is False, 'The held approval must retain its current live execution'
    pending = [item for item in original['pending'] if item['kind'] == 'approval'
        and item.get('toolName') == event['toolName'] and event['approvalId'] ==
            'agent-decision-' + json.dumps([original['ref']['id'], item['id']], separators=(',', ':'), ensure_ascii=False).encode().hex()]
    assert len(pending) == 1 and pending[0]['delivery'] == 'continue_run', 'Expected one live provider approval callback'
    actor = request('/api/auth/session')['user']['id']
    binding = {'userId': actor, 'providerAppId': provider_id,
        'subject': {'kind': 'agent-run', 'id': original['ref']['id'], 'revision': original['generation']},
        'correlationKey': original['ref']['id'] + ':' + pending[0]['id'],
        'questions': [{'id': 'approval', 'question': event['toolName'],
            'options': [{'id': 'allow', 'label': 'Allow'}, {'id': 'deny', 'label': 'Deny'}], 'allowText': True}]}
    decision = _wait(lambda: _pending_decision(request, binding), 30)
    assert _same_installation(decision.get('sourceInstallation'), original['ref']['provider']['installationId']), 'The Core Decision must belong to the original provider installation'
    route = '/api/decisions/v1/requests/' + decision['id']
    provider_identity = request('/api/apps/' + provider_id + '/health')['services']
    harness_identity = context['harnessRuntimeIdentity']()

    def assert_harness_stopped():
        apps = request('/api/apps')['apps']
        assert next(app for app in apps if app['id'] == app_id)['runtimeState'] == 'stopped', 'Harness must remain physically stopped before provider completion'
        health = request('/api/apps/' + provider_id + '/health')
        assert health['status'] == 'healthy', 'The independently running provider must stay healthy'
        identity = [(service.get('processId'), service.get('startedAt')) for service in health['services']]
        assert identity == [(service.get('processId'), service.get('startedAt')) for service in provider_identity], 'The provider must not restart during renewal'

    def current_decision():
        row = request(route)
        assert _same_decision(row, binding), 'Core Decision actor/provider/run/question binding changed'
        assert _same_installation(row.get('sourceInstallation'), decision.get('sourceInstallation')), 'The provider installation changed'
        return row

    stopped = False
    try:
        context['run']([context['cli'], '--data-root', context['root'], 'apps', 'stop', app_id])
        stopped = True
        assert_harness_stopped()
        began = time.monotonic()
        say('MCP TTL acceptance: Harness stopped at its provider-owned list_apps approval; waiting 310 real seconds')
        reported = 0
        while (elapsed := time.monotonic() - began) < MCP_TTL_WAIT_SECONDS:
            row = current_decision()
            assert row['state'] == 'pending' and row['revision'] == decision['revision'], 'The approval must remain pending without another consumer'
            assert_harness_stopped()
            if elapsed >= reported + 60:
                say('MCP TTL acceptance: Harness remains stopped after ' + str(int(elapsed)) + ' seconds')
                reported = elapsed
            time.sleep(min(30, MCP_TTL_WAIT_SECONDS - elapsed))
        elapsed = time.monotonic() - began
        assert elapsed >= 310, 'The real Core MCP token TTL must expire; shortened waits are not acceptance'
        assert_harness_stopped()
        row = current_decision()
        assert row['state'] == 'pending' and row['revision'] == decision['revision']
        command = {'requestId': str(uuid.uuid4()), 'expectedRevision': decision['revision'],
            'answers': {'approval': {'optionIds': ['allow']}}}
        resolved = request(route + '/resolve', command)
        assert resolved['state'] == 'answered' and resolved['resolution']['userId'] == actor
        _assert_allow_answer(resolved['resolution']['answers'])
        # An uncertain HTTP acknowledgement can repeat only these exact UUID/body bytes.
        assert request(route + '/resolve', command) == resolved, 'Core resolution replay must preserve the original receipt'

        def completed():
            assert_harness_stopped()
            current = current_decision()
            continuation = current.get('continuation') or {}
            assert continuation.get('state') not in ('failed', 'cancelled'), 'The provider continuation failed while Harness was stopped'
            return current if continuation.get('state') == 'completed' else None
        finished = _wait(completed, 90)
        assert finished['delivery']['receivedAt'], 'The provider must acknowledge the exact response independently'
        assert finished['resolution'] == resolved['resolution'], 'The original canonical Core resolution changed during continuation'
        assert_core_dispatch(model_requests, tool, app_id, provider_id)
        say('PASS: real Core list_apps returned the stopped Harness and running provider; its continuation completed after ' + str(int(elapsed)) + ' seconds with Harness stopped')
    finally:
        if stopped:
            timed('start')
            assert call(app_origin, '/api/sessions/' + session_id + '/credentials', {}) == {'updated': True}, 'Reconnect through the original operator session without replaying native input'
    assert context['harnessRuntimeIdentity']() != harness_identity, 'Core must launch a replacement Harness runtime'
    return {'runId': original['ref']['id'], 'generation': original['generation'],
        'configurationRevision': original['configurationRevision'], 'decisionId': decision['id']}


def assert_core_dispatch(model_requests, tool, app_id, provider_id):
    """Validate a real Core tool response in the next synthetic-model request, before restart."""
    messages = model_requests[-1]['messages']
    results = [message for message in messages if message.get('role') == 'tool' and message.get('tool_name') == tool['alias']]
    assert len(results) == 1, 'The model must receive exactly one result for this discovered Core alias'
    receipt = json.loads(results[0]['content'])
    assert receipt['status'] == 'completed' and not receipt.get('truncated'), 'The Core tool must return a complete, successful result'
    # toolResult renders MCP text blocks directly; the envelope/transport is not content.
    payload = json.loads(receipt['output'])
    assert isinstance(payload, dict) and isinstance(payload.get('apps'), list), 'Expected the actual Core list_apps payload'
    apps = payload['apps']
    assert next(app for app in apps if app['id'] == app_id)['runtimeState'] == 'stopped', 'Core dispatch must happen while Harness is stopped'
    assert next(app for app in apps if app['id'] == provider_id)['runtimeState'] == 'running', 'The independent provider must perform the configured Core dispatch'
