"""Selected skill imports using the existing parent-managed Core acceptance owner."""
import http.server
import json
import pathlib
import subprocess
import threading
import urllib.parse


def check(g):
    base, root, cli, run, request, say = (g[key] for key in ('base', 'root', 'cli', 'run', 'request', 'say'))
    source = base / 'skill-source'
    source.mkdir()
    run(['git', 'init', '-b', 'main'], source)

    def package(relative, name, text='first'):
        directory = source / relative
        directory.mkdir(parents=True, exist_ok=True)
        (directory / 'SKILL.md').write_text(f'---\nname: {name}\ndescription: Fixture skill {name}.\n---\nRead references/value.txt.\n', encoding='utf-8')
        (directory / 'references').mkdir(exist_ok=True)
        (directory / 'references/value.txt').write_text(text, encoding='utf-8')

    for i in range(240):
        package(f'skills/guide-{i}', f'guide-{i}')
    # Unselected packages can be invalid in their ancillary files without blocking selected imports.
    for i in range(513):
        (source / f'skills/guide-100/extra-{i}.txt').write_text('fixture', encoding='utf-8')
    with (source / 'skills/guide-101/SKILL.md').open('a', encoding='utf-8') as instructions:
        instructions.write('x' * (256 * 1024))
    package('a/duplicate', 'duplicate')
    package('b/duplicate', 'duplicate')

    def commit(message):
        run(['git', 'add', '.'], source)
        run(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', message], source)
        return run(['git', 'rev-parse', 'HEAD'], source).strip()

    first_commit = commit('Initial isolated skills')
    requests = []

    class GitHandler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def serve_git(self):
            url = urllib.parse.urlsplit(self.path)
            length = int(self.headers.get('Content-Length', '0'))
            body = self.rfile.read(length)
            env = dict(g['env'], GIT_PROJECT_ROOT=str(base), GIT_HTTP_EXPORT_ALL='1',
                       REQUEST_METHOD=self.command, PATH_INFO=url.path, QUERY_STRING=url.query,
                       CONTENT_TYPE=self.headers.get('Content-Type', ''), CONTENT_LENGTH=str(length),
                       REMOTE_ADDR='127.0.0.1', HTTP_GIT_PROTOCOL=self.headers.get('Git-Protocol', ''))
            result = subprocess.run(['git', 'http-backend'], input=body, env=env, capture_output=True, timeout=120)
            if result.returncode:
                self.send_error(500, 'Fixture Git backend failed')
                return
            headers, separator, payload = result.stdout.partition(b'\r\n\r\n')
            if not separator:
                headers, _, payload = result.stdout.partition(b'\n\n')
            parsed = [line.decode().split(':', 1) for line in headers.splitlines() if b':' in line]
            status = next((int(value.strip().split()[0]) for key, value in parsed if key.lower() == 'status'), 200)
            requests.append((self.command, url.path, status))
            self.send_response(status)
            for key, value in parsed:
                if key.lower() not in ('status', 'content-length'):
                    self.send_header(key, value.strip())
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        do_GET = do_POST = serve_git

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), GitHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    repository = f'http://127.0.0.1:{server.server_port}/skill-source/.git'

    def command(*args):
        return run([cli, '--data-root', root, 'skills', *args])

    def fail(*args, code):
        result = subprocess.run([str(cli), '--data-root', str(root), 'skills', *args], env=g['env'], capture_output=True, text=True, timeout=180)
        assert result.returncode == 1, result.returncode
        assert code in result.stdout + result.stderr, result.stdout + result.stderr
        assert 'Installed ' not in result.stdout

    export = None
    try:
        assert all(skill['sourceKind'] == 'core' for skill in request('/api/skills')['skills'])
        installed = json.loads(command('add', repository, '--skill', 'guide-0', '--skill', 'guide-239', '--skill', 'guide-0', '--format', 'json'))['skills']
        assert [skill['name'] for skill in installed] == ['guide-0', 'guide-239']
        assert all(skill['commit'] == first_commit for skill in installed)
        ids = [skill['id'] for skill in installed]
        assert len(json.loads(command('list', '--format', 'json'))['skills']) == 4
        assert 'guide-239' in command('list')
        assert 'name: guide-0' in command('read', ids[0])
        export = json.loads(command('export', '--context', 'skills-acceptance', '--skill', ids[0]))
        exported_value = pathlib.Path(export['path']) / 'guide-0/references/value.txt'
        assert exported_value.read_text() == 'first'
        assert len(request('/api/skills')['skills']) == 4
        say('PASS: large catalog add/list/read/export, duplicate selector normalization and shared administrator catalog')

        fail('add', repository, '--skill', 'guide-0', '--skill', 'missing', code='skill_not_found')
        fail('add', repository, '--skill', 'guide-100', code='skill_package_invalid')
        fail('add', repository, '--skill', 'guide-101', code='skill_package_invalid')
        fail('add', repository, '--skill', 'duplicate', code='skill_name_ambiguous')
        assert len(json.loads(command('list', '--format', 'json'))['skills']) == 4
        assert exported_value.read_text() == 'first'
        narrowed = json.loads(command('add', repository, '--skill', 'duplicate', '--path', 'a', '--ref', 'main', '--format', 'json'))['skills']
        assert narrowed[0]['path'] == 'a/duplicate' and narrowed[0]['ref'] == 'main'

        # Force a ref move between discovery and installation through the actual HTTP contract.
        git_source = {'repository': repository, 'ref': 'HEAD', 'path': ''}
        selection = request('/control/v1/skills/discover', {'source': git_source, 'names': ['guide-0']}, control=True)
        package('skills/guide-0', 'guide-0', 'second')
        second_commit = commit('Change selected package')
        try:
            request('/control/v1/skills/install', {'source': git_source, 'commit': selection['commit'], 'names': ['guide-0']}, control=True)
        except RuntimeError as error:
            assert 'skill_source_changed' in str(error), str(error)
        else:
            raise AssertionError('Moved source was accepted')
        assert exported_value.read_text() == 'first'
        summary = command('add', repository, '--skill', 'guide-0')
        assert 'Installed 1 skill(s).' in summary and 'guide-0' in summary
        current = next(skill for skill in json.loads(command('list', '--format', 'json'))['skills'] if skill['id'] == ids[0])
        assert current['commit'] == second_commit and exported_value.read_text() == 'second'
        assert any(path.endswith('/git-upload-pack') for _, path, _ in requests)
        command('release', export['id'])
        assert not pathlib.Path(export['path']).exists()
        export = None
        say('PASS: atomic failures, path/ref selection, moved source rejection, stable IDs, current export refresh and release')

        # A live upstream probe is separate from the deterministic cases above. It must pass before
        # this acceptance run succeeds; failures are identified without hiding fixture results.
        try:
            summary = command('add', 'https://github.com/github/awesome-copilot', '--skill', 'csharp-xunit')
            assert 'csharp-xunit' in summary and 'Installed 1 skill(s).' in summary
            skill = next(skill for skill in json.loads(command('list', '--format', 'json'))['skills'] if skill['name'] == 'csharp-xunit')
            assert skill['path'] == 'skills/csharp-xunit'
            assert 'name: csharp-xunit' in command('read', skill['id'])
            say('PASS: requested awesome-copilot command; commit ' + skill['commit'])
        except Exception as error:
            raise RuntimeError('Live awesome-copilot verification failed after deterministic skills checks passed: ' + str(error)) from error
    finally:
        if export is not None:
            command('release', export['id'])
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        assert not thread.is_alive()
