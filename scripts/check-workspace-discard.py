#!/usr/bin/env python3
"""Discard acceptance in a disposable parent-managed source Core with normal login.

Build Core/CLI, SDK and Harness web first. Run from a registered source worktree:
  python3 scripts/check-workspace-discard.py .
  python3 scripts/check-workspace-discard.py . --keep
  python3 scripts/check-workspace-discard.py --finish-state /tmp/hosty-discard-*/stand.json

--keep retains the owned child, Harness, Shell and a second dirty external workspace
for browser acceptance. It prints a private credentials-file path, never credentials.
Finish the retained stand with --finish-state; it uses the original parent lifecycle.
No existing Core, workspace, application data or provider connection is consumed.
"""
import argparse
import base64
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


MARKER = "hosty-workspace-discard-acceptance.1"
PROJECT = "apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj"
EMAIL = "discard-acceptance@example.test"
SECRETS = set()
PROCESSES = {}
# Resolve only the local names Core allocates; do not depend on OS wildcard DNS.
RESOLVE = socket.getaddrinfo
socket.getaddrinfo = lambda host, *args, **kwargs: RESOLVE(
    "127.0.0.1" if host and host.endswith(".localhost") else host, *args, **kwargs)
ENV = {key: os.environ[key] for key in (
    "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "DOTNET_ROOT", "LANG", "SystemRoot",
    "COMSPEC", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "ProgramFiles",
    "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)",
    "CommonProgramW6432", "ProgramData", "SystemDrive", "windir", "HOMEDRIVE", "HOMEPATH",
) if key in os.environ}
ENV.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1", GIT_TERMINAL_PROMPT="0")


def say(value):
    text = str(value)
    for secret in sorted(SECRETS, key=len, reverse=True):
        if len(secret) >= 4:
            text = text.replace(secret, "[REDACTED]")
    print(text, flush=True)


def private_json(path, value):
    path = Path(path)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")
    path.chmod(0o600)


def read_private(path):
    path = Path(path)
    if path.is_symlink() or path.stat().st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise RuntimeError("Stand state and credentials must be private regular files.")
    return json.loads(path.read_text())


def run(args, cwd=None, check=True, timeout=600):
    result = subprocess.run([str(arg) for arg in args], cwd=cwd, env=ENV,
                            capture_output=True, text=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError("Command failed: " + str(args[0]) + "\n" + result.stderr[-1600:] + result.stdout[-800:])
    return result


def git(path, *args, check=True):
    return run(["git", "-C", path, *args], check=check).stdout.strip()


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def wait_for(callback, seconds=120):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = callback()
        if result:
            return result
        time.sleep(0.1)
    raise TimeoutError("Timed out waiting for an owned fixture boundary.")


def listening(port):
    with socket.socket() as probe:
        probe.settimeout(0.3)
        return probe.connect_ex(("127.0.0.1", int(port))) == 0


class ApiError(RuntimeError):
    def __init__(self, status, value):
        self.status = status
        self.value = value if isinstance(value, dict) else {}
        self.code = self.value.get("code", "unreadable_error")
        super().__init__(f"HTTP {status}: {self.code}")


class Client:
    def __init__(self, origin, data_root=None):
        parsed = urllib.parse.urlsplit(origin)
        if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost") and not (parsed.hostname or "").endswith(".localhost"):
            raise RuntimeError("Acceptance clients require an exact local Core/app origin.")
        self.origin = f"{parsed.scheme}://{parsed.netloc}"
        self.data_root = Path(data_root) if data_root else None
        self.jar = http.cookiejar.CookieJar()
        self.browser = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(self.jar))
        self.csrf = None

    def request(self, path, body=None, method=None, control=False, reviewed=False, headers=None, form=False):
        hdr = {"Origin": self.origin, "Content-Type": "application/x-www-form-urlencoded" if form else "application/json", **(headers or {})}
        if self.csrf:
            hdr["X-Hosty-CSRF"] = self.csrf
        if control:
            discovery = json.loads((self.data_root / "core/run/control.json").read_text())
            hdr.update(discovery["requiredHeaders"])
            SECRETS.update(str(value) for value in discovery["requiredHeaders"].values())
        payload = (urllib.parse.urlencode(body) if form else json.dumps(body)).encode() if body is not None else None
        request = urllib.request.Request(self.origin + path, data=payload, headers=hdr, method=method)
        try:
            with self.browser.open(request, timeout=600) as response:
                raw = response.read().decode()
        except urllib.error.HTTPError as error:
            try:
                value = json.loads(error.read())
            except (ValueError, UnicodeError):
                value = {}
            if error.code == 428 and reviewed:
                review_id = value["id"]
                with self.browser.open(self.origin + "/settings/confirm/" + review_id, timeout=20) as page:
                    html = page.read().decode()
                nonce = re.search(r'name=nonce value="([^"]+)"', html)
                if not nonce:
                    raise RuntimeError("Core review did not provide its ordinary confirmation form.")
                SECRETS.add(nonce.group(1))
                decision = urllib.parse.urlencode({"nonce": nonce.group(1), "decision": "approve"}).encode()
                with self.browser.open(urllib.request.Request(self.origin + "/settings/confirm/" + review_id, data=decision,
                        headers={"Content-Type": "application/x-www-form-urlencoded", "Origin": self.origin}), timeout=20) as response:
                    response.read()
                return self.request(path, body, method, control, False, {**(headers or {}), "X-Hosty-Settings-Change": review_id}, form)
            raise ApiError(error.code, value) from None
        if not raw:
            return None
        if raw.lstrip().startswith("{") or raw.lstrip().startswith("["):
            return json.loads(raw)
        frames = [line[5:].strip() for line in raw.splitlines() if line.startswith("data:")]
        if frames:
            return json.loads(frames[-1])
        raise RuntimeError("Expected a JSON or MCP result, not HTML.")

    def login(self, password):
        self.jar.clear()
        self.csrf = None
        form = urllib.parse.urlencode({"email": EMAIL, "password": password, "returnTo": "/account/tokens"}).encode()
        # A successful normal login may land on Core's HTML welcome page when no Shell
        # is installed. Its authenticated session, not the continuation body, is evidence.
        with self.browser.open(urllib.request.Request(self.origin + "/login", data=form,
                headers={"Content-Type": "application/x-www-form-urlencoded", "Origin": self.origin}), timeout=20) as response:
            response.read()
        if not self.request("/api/auth/session")["authenticated"]:
            raise RuntimeError("Ordinary password login failed.")
        self.csrf = self.request("/api/auth/csrf")["token"]
        SECRETS.add(self.csrf)

    def mcp(self, credential, tool_name, **arguments):
        envelope = self.request("/api/mcp", {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": {"name": tool_name, "arguments": arguments}}, headers={"Authorization": "Bearer " + credential,
            "Accept": "application/json, text/event-stream"})
        if envelope.get("error"):
            raise RuntimeError("MCP request was refused.")
        result = envelope["result"]
        if result.get("isError"):
            raise RuntimeError("MCP fixture operation was refused.")
        value = json.loads(next(item["text"] for item in result["content"] if item.get("type") == "text"))
        if value.get("error"):
            raise RuntimeError("MCP fixture operation failed: " + str(value.get("code", "workspace_error")))
        return value


def start_identity(pid):
    if os.name == "nt":
        raise RuntimeError("This fixture currently supports macOS/Linux native Core; Windows acceptance is separate.")
    return run(["ps", "-p", str(pid), "-o", "lstart="], check=False).stdout.strip()


def process_still_owned(pid, started):
    process = PROCESSES.get(pid)
    if process is not None and process.poll() is not None:
        return False
    return bool(started) and start_identity(pid) == started


def expect_refusal(callback, codes=None):
    try:
        callback()
    except ApiError as error:
        if error.status not in (400, 403, 404, 409, 412):
            raise
        if codes and error.code not in codes:
            raise RuntimeError("Unexpected refusal: " + error.code)
        return error.code
    raise AssertionError("A refused operation unexpectedly succeeded.")


def install(client, cli, root, manifest, runtime):
    run([cli, "--data-root", root, "apps", "install", manifest, "--runtime", runtime, "--no-autostart"])


def runtime_fixture(base, workspace, app_name, runtime, environment=None):
    """Install a private reviewed fixture; never rebuild or rewrite the live worktree."""
    original = workspace / "apps" / app_name
    manifest = json.loads((original / "manifest.json").read_text())
    manifest["source"]["repository"] = str(workspace)
    for profile in manifest["runtimeProfiles"]:
        if profile["key"] == runtime:
            # Freeze this disposable declaration. A live profile would reread the original
            # source manifest and reintroduce setup/output settings from the live instance.
            profile["development"] = False
    for service in manifest["services"]:
        selected = service["runtimes"][runtime]
        selected.pop("setup", None)
        selected.setdefault("environment", {}).update((environment or {}).get(service["key"], {}))
        if app_name == "shell":
            # An independent Next dev process must never share the live server's dev lock
            # or chunk graph. This is an owned ignored build directory, removed on Finish.
            selected["environment"].update(NEXT_DIST_DIR=".next/discard-" + base.name, NEXT_TELEMETRY_DISABLED="1")
    destination = base / "runtime-manifests" / app_name
    destination.mkdir(parents=True)
    metadata = manifest.get("catalogMetadata", {})
    for reference in (metadata.get("icon"), metadata.get("descriptionFile")):
        if not reference or urllib.parse.urlsplit(reference).scheme:
            continue
        source = (original / reference).resolve()
        target = (destination / reference).resolve()
        if not source.is_relative_to(original.resolve()) or not target.is_relative_to(destination.resolve()):
            raise RuntimeError("Fixture asset escapes the app manifest directory.")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    for skill in manifest.get("agent", {}).get("skills", []):
        source = (original / skill["path"]).resolve()
        target = (destination / skill["path"]).resolve()
        if not source.is_relative_to(original.resolve()) or not target.is_relative_to(destination.resolve()):
            raise RuntimeError("Fixture skill escapes the app manifest directory.")
        shutil.copytree(source, target)
    path = destination / "manifest.json"
    private_json(path, manifest)
    return path


def start_app(client, cli, root, app_id):
    run([cli, "--data-root", root, "apps", "start", app_id])
    def ready():
        app = next((item for item in client.request("/api/apps")["apps"] if item["id"] == app_id), None)
        if app and app["runtimeState"] == "failed":
            raise RuntimeError("Fixture application start failed: " + app_id)
        return app if app and app["runtimeState"] == "running" else None
    return wait_for(ready, 180)


def app_origin(app, instance_id):
    endpoint = next(item for item in app["endpoints"] if item.get("browserOrigin") or item.get("localOrigin") or item.get("url"))
    value = endpoint.get("browserOrigin") or endpoint.get("localOrigin") or endpoint["url"]
    parsed = urllib.parse.urlsplit(value)
    if not (parsed.hostname or "").endswith(f".i-{instance_id}.hosty.localhost"):
        raise RuntimeError("Disposable browser apps need the exact child instance hostname to isolate cookies/storage.")
    return f"{parsed.scheme}://{parsed.netloc}"


def authorize_app(core, app):
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    code = core.request("/api/auth/apps/authorize", {"appId": "hosty.harness", "redirectUri": app.origin + "/callback",
        "codeChallenge": challenge, "codeChallengeMethod": "S256"})
    grant = app.request("/api/app-code", {"code": code["code"], "codeVerifier": verifier})
    SECRETS.add(grant["accessToken"])
    return grant["accessToken"]


def grant_fixture_environment_permissions(core):
    required = {"core.environments.read", "core.environments.manage"}
    def installed():
        return next(app for app in core.request("/api/apps")["apps"] if app["id"] == "hosty.harness")
    current = installed()
    if required.issubset(current.get("grantedCorePermissions", [])):
        return
    # Use the ordinary isolated Core permission confirmation, selecting only the
    # two already-declared capabilities needed to inspect/finish our synthetic child.
    with core.browser.open(core.origin + "/install/permissions/hosty.harness", timeout=20) as response:
        html, target = response.read().decode(), response.url
    if not target.startswith(core.origin + "/install/confirm/"):
        raise RuntimeError("Core did not provide its isolated permission confirmation.")
    nonce = re.search(r'name=nonce value="([^"]+)"', html)
    if not nonce:
        raise RuntimeError("Core permission review did not provide its normal nonce.")
    SECRETS.add(nonce.group(1))
    selected = required | (set(current.get("grantedCorePermissions", [])) & set(current.get("optionalCorePermissions", [])))
    form = urllib.parse.urlencode([("nonce", nonce.group(1)), ("decision", "approve"),
        *[("optionalPermission", value) for value in sorted(selected)]]).encode()
    with core.browser.open(urllib.request.Request(target, data=form,
            headers={"Content-Type": "application/x-www-form-urlencoded", "Origin": core.origin}), timeout=20) as response:
        response.read()
    wait_for(lambda: required.issubset(installed().get("grantedCorePermissions", [])), 30)


def fixture_repositories(base, server_port):
    manifests = []
    for number in (1, 2):
        repo = base / f"repository-{number}"
        repo.mkdir()
        git(repo, "init", "-b", "main")
        (repo / "README.md").write_text(f"Preserve original repository {number}.\n")
        (repo / ".gitignore").write_text("ignored/\n")
        for suffix in (["one", "shared"] if number == 1 else ["two"]):
            app_id = "test.discard." + suffix
            folder = repo / suffix
            folder.mkdir()
            manifest = {"schemaVersion": "app.0.1", "id": app_id, "name": "Discard fixture " + suffix,
                "description": "Disposable workspace-discard source fixture.", "version": "0.1.0",
                "source": {"type": "git", "repository": f"http://127.0.0.1:{server_port}/repository-{number}/.git", "branch": "main"},
                "runtimeProfiles": [{"key": "local", "type": "localCommand", "default": True}], "defaultRuntime": "local",
                "services": [{"key": "idle", "runtimes": {"local": {"type": "localCommand", "workingDirectory": suffix,
                    "command": "node -e 'setInterval(()=>{},1000)'"}}}]}
            path = folder / "manifest.json"
            path.write_text(json.dumps(manifest))
            manifests.append((app_id, f"http://127.0.0.1:{server_port}/repository-{number}/{suffix}/manifest.json"))
        git(repo, "add", ".")
        git(repo, "-c", "user.name=Acceptance fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Initial disposable fixture")
        git(repo, "update-server-info")
    return manifests


def prepare_group(core, credential, task, name, app_ids, dirty=True):
    trees = {}
    leases = []
    for app_id in app_ids:
        lease = str(uuid.uuid4())
        tree = core.mcp(credential, "prepare_workspace", requestId=str(uuid.uuid4()), taskId=task, appId=app_id,
                        leaseId=lease, name=name, targetBranch="main")
        if trees and tree["workspaceId"] != next(iter(trees.values()))["workspaceId"]:
            raise AssertionError("Additional repositories did not share the logical external workspace.")
        trees[tree["id"]] = tree
        leases.append((tree["id"], lease))
    for index, tree in enumerate(trees.values()):
        path = Path(tree["path"])
        (path / "unmerged.txt").write_text("Synthetic unmerged commit.\n")
        git(path, "add", "unmerged.txt")
        git(path, "-c", "user.name=Acceptance fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Unmerged disposable change")
        if dirty:
            (path / "README.md").write_text(f"Discard reviewed dirty bytes {index}.\n")
            (path / "untracked.bin").write_bytes(b"untracked\x00fixture\xff")
            (path / "ignored").mkdir()
            (path / "ignored/cache.bin").write_bytes(b"ignored temporary fixture\x00")
        common = Path(git(path, "rev-parse", "--git-common-dir"))
        tree["fixtureCommon"] = str(common if common.is_absolute() else (path / common).resolve())
    for tree_id, lease in leases:
        core.mcp(credential, "release_workspace_lease", workspaceId=tree_id, requestId=str(uuid.uuid4()), leaseId=lease)
    return list(trees.values())


def data_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def assert_removed(root, trees):
    for tree in trees:
        path = Path(tree["path"])
        common = Path(tree["fixtureCommon"])
        assert not path.exists(), "Discarded worktree path remains."
        assert common.is_dir(), "Shared Git repository was removed."
        assert not git(common, "show-ref", "--verify", "refs/heads/" + tree["branch"], check=False), "Private workspace branch remains."
        assert str(path) not in git(common, "worktree", "list", "--porcelain"), "Git worktree registration remains."
        for directory in ("workspaces", "publications", "publications/external", "publications/review-operations"):
            assert not (root / "core/development" / directory / (tree["id"] + ".json")).exists(), "Workspace-owned metadata remains."


def finish_stand(state_path):
    state_path = Path(state_path).resolve()
    state = read_private(state_path)
    base = Path(state["base"]).resolve()
    if state.get("kind") != MARKER or state_path != base / "stand.json" or not base.name.startswith("hosty-discard-"):
        raise RuntimeError("Refusing a state file outside its owned disposable stand.")
    if not base.is_relative_to(Path(tempfile.gettempdir()).resolve()) or Path(state["parentRoot"]).resolve() != base / "parent":
        raise RuntimeError("Refusing a stand outside its original temporary parent root.")
    if state.get("childRoot") and not Path(state["childRoot"]).resolve().is_relative_to(base):
        raise RuntimeError("Refusing a child root outside the disposable stand.")
    credentials = read_private(base / "credentials.json")
    SECRETS.add(credentials["password"])
    parent = Client(state["parentOrigin"], state["parentRoot"])
    parent.login(credentials["password"])
    if state.get("childId"):
        child = parent.request("/api/core-environments/" + state["childId"])
        command = state.get("finishRequest") or {"requestId": str(uuid.uuid4()), "expectedRevision": child["revision"]}
        state["finishRequest"] = command
        private_json(state_path, state)
        child = parent.request("/api/core-environments/" + state["childId"] + "/operations/finish", command)
        assert child["state"] == "finished", "Parent Finish did not confirm cleanup."
        child_port = state.get("childPort", child["port"])
        child_root = state.get("childRoot") or child.get("dataRoot")
        assert not listening(child_port), "Child Core port is still open."
        if child_root:
            assert not Path(child_root).exists(), "Child-owned data root remains after Finish."
        for command in (["ps", "-aq"], ["network", "ls", "-q"], ["volume", "ls", "-q"]):
            assert not run(["docker", *command, "--filter", "label=hosty.instance=" + state["childId"]]).stdout.strip(), "Owned Docker resources remain."
    try:
        parent.request("/control/v1/core/stop", {}, control=True)
    except (urllib.error.URLError, ConnectionError):
        pass  # A closed response is not success; verify the owned listener drained below.
    wait_for(lambda: not listening(state["parentPort"]), 45)
    wait_for(lambda: not process_still_owned(state["parentPid"], state.get("parentStarted")), 45)
    server = state.get("server")
    if server and process_still_owned(server["pid"], server["started"]):
        os.kill(server["pid"], signal.SIGTERM)
        wait_for(lambda: not listening(server["port"]), 20)
        wait_for(lambda: not process_still_owned(server["pid"], server["started"]), 20)
    shell_build = state.get("shellBuildPath")
    if shell_build:
        build_path = Path(shell_build)
        source_workspace = Path(state["workspace"]).resolve()
        expected_build = source_workspace / "apps/shell/.next" / ("discard-" + base.name)
        if build_path != expected_build or build_path.is_symlink() or build_path.parent.is_symlink():
            raise RuntimeError("Refusing to remove an unrecognized Shell fixture build directory.")
        if build_path.exists():
            shutil.rmtree(build_path)
    shutil.rmtree(base)
    say("CLEANUP: parent Finish removed the child Core/apps/data and owned Docker resources; parent and fixture server stopped.")


def acceptance(workspace, keep, core_binary=None, cli_binary=None, resume_state=None):
    workspace = Path(workspace).resolve()
    if os.name == "nt":
        raise RuntimeError("Run this native acceptance on macOS/Linux; Windows requires separate verification.")
    suffix = ".exe" if os.name == "nt" else ""
    cli = Path(cli_binary).resolve() if cli_binary else workspace / ("apps/cli/src/Haas.Hosty.Cli/bin/Debug/net10.0/hosty" + suffix)
    core = Path(core_binary).resolve() if core_binary else workspace / ("apps/core/src/Haas.Hosty.Core/bin/Debug/net10.0/hosty-core" + suffix)
    for path in (cli, core, workspace / PROJECT, workspace / "apps/harness/web/out/index.html"):
        if not path.exists():
            raise RuntimeError("Build the final Core/CLI and Harness web before acceptance: missing " + str(path))
    run(["docker", "info", "--format", "{{.ServerVersion}}"], timeout=30)
    if resume_state:
        state_path = Path(resume_state).resolve()
        state = read_private(state_path)
        base = Path(state["base"]).resolve()
        if state.get("kind") != MARKER or state_path != base / "stand.json" or not base.name.startswith("hosty-discard-") or not base.is_relative_to(Path(tempfile.gettempdir()).resolve()):
            raise RuntimeError("Resume requires this runner's private disposable stand.")
        if state.get("stage") not in ("ready-for-fixtures", "fixtures-ready", "main-ready") or state.get("discardCommand") or state.get("apiPassed"):
            raise RuntimeError("Only pre-admission fixture checkpoints can resume; retain original discard recovery identities otherwise.")
        root = Path(state["parentRoot"]).resolve()
        if root != base / "parent" or not Path(state["childRoot"]).resolve().is_relative_to(root):
            raise RuntimeError("Resume cannot select resources outside the owned disposable parent.")
        password = read_private(base / "credentials.json")["password"]
        SECRETS.add(password)
    else:
        base = Path(tempfile.mkdtemp(prefix="hosty-discard-")).resolve()
        base.chmod(0o700)
        root = base / "parent"
        (root / "core").mkdir(parents=True)
        (root / "core/distribution-apps.json").write_text('{"schemaVersion":"distribution-apps.0.1","apps":[]}')
        password = secrets.token_urlsafe(32) + "aA1!"
        SECRETS.add(password)
        private_json(base / "credentials.json", {"email": EMAIL, "password": password})
        port = free_port()
        state = {"kind": MARKER, "workspace": str(workspace), "base": str(base), "parentRoot": str(root), "parentOrigin": f"http://127.0.0.1:{port}", "parentPort": port}
        state_path = base / "stand.json"
        private_json(state_path, state)
        environment = {**ENV, "HOSTY_DATA_ROOT": str(root), "HOSTY_CORE_URL": state["parentOrigin"], "HOSTY_CORE_PORT": str(port),
            "HOSTY_DISTRIBUTION_APPS_PATH": str(root / "core/distribution-apps.json"), "HOSTY_CORE_LAUNCH_MODE": "dev",
            "HOSTY_CORE_PROJECT": str(workspace / PROJECT), "HOSTY_CLI_PATH": str(cli)}
        with (base / "parent.log").open("w") as log:
            parent_process = subprocess.Popen([str(core)], env=environment, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        PROCESSES[parent_process.pid] = parent_process
        state["parentPid"] = parent_process.pid
        state["parentStarted"] = start_identity(parent_process.pid)
        private_json(state_path, state)
    success = False
    try:
        parent = Client(state["parentOrigin"], root)
        if not resume_state:
            wait_for(lambda: (root / "core/run/control.json").exists(), 30)
            token = parent.request("/control/v1/auth/setup-token", {}, control=True)["token"]
            SECRETS.add(token)
            parent.request("/api/auth/bootstrap", {"setupToken": token, "email": EMAIL, "displayName": "Discard acceptance", "password": password})
            parent.login(password)
            say("Creating a parent-managed source Core from the final registered worktree.")
            child = parent.request("/api/core-environments", {"requestId": str(uuid.uuid4()), "label": "Disposable discard acceptance", "mode": "source", "projectPath": str(workspace / PROJECT)})
            state["childId"] = child["id"]
            private_json(state_path, state)
            child = parent.request(f"/api/core-environments/{child['id']}/operations/start", {"requestId": str(uuid.uuid4()), "expectedRevision": child["revision"]})
            assert child["state"] == "running", "Managed source Core did not start."
            state.update(childRoot=child["dataRoot"], childOrigin=child["previewUrl"], childPort=child["port"])
            assert Path(state["childRoot"]).resolve().is_relative_to(base)
            private_json(state_path, state)
            parent.request(f"/api/core-environments/{child['id']}/setup", {"email": EMAIL, "displayName": "Discard acceptance", "password": password})
        else:
            parent.login(password)
            child = parent.request(f"/api/core-environments/{state['childId']}")
            assert child["state"] == "running" and Path(child["dataRoot"]).resolve() == Path(state["childRoot"]).resolve()
        child_core = Client(state["childOrigin"], state["childRoot"])
        child_core.login(password)
        child_root = Path(state["childRoot"])
        if not resume_state:
            harness_manifest = runtime_fixture(base, workspace, "harness", "local", {"api": {"HOSTY_HARNESS_WEB_OUTPUT": "out"}})
            install(child_core, cli, child_root, harness_manifest, "local")
            harness_app = start_app(child_core, cli, child_root, "hosty.harness")
            harness = Client(app_origin(harness_app, state["childId"]))
            authorize_app(child_core, harness)
            state["harnessOrigin"] = harness.origin
            if keep:
                shell_manifest = runtime_fixture(base, workspace, "shell", "dev")
                state["shellBuildPath"] = str(workspace / "apps/shell/.next" / ("discard-" + base.name))
                private_json(state_path, state)
                install(child_core, cli, child_root, shell_manifest, "dev")
                shell = start_app(child_core, cli, child_root, "hosty.shell")
                state["shellOrigin"] = app_origin(shell, state["childId"])
            private_json(state_path, state)
            server_port = free_port()
            fixtures = base / "fixtures"
            fixtures.mkdir()
            with (base / "fixture-server.log").open("w") as log:
                server = subprocess.Popen([sys.executable, "-m", "http.server", str(server_port), "--bind", "127.0.0.1", "--directory", str(fixtures)],
                    env=ENV, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            PROCESSES[server.pid] = server
            state["server"] = {"pid": server.pid, "started": start_identity(server.pid), "port": server_port}
            private_json(state_path, state)
            wait_for(lambda: listening(server_port), 10)
            manifests = fixture_repositories(fixtures, server_port)
            for app_id, manifest in manifests:
                install(child_core, cli, child_root, manifest, "local")
            state.update(fixtureManifests=manifests, stage="ready-for-fixtures")
            private_json(state_path, state)
        else:
            fixtures = base / "fixtures"
            manifests = state["fixtureManifests"]
            harness_app = start_app(child_core, cli, child_root, "hosty.harness")
            harness = Client(app_origin(harness_app, state["childId"]))
            authorize_app(child_core, harness)
            state["harnessOrigin"] = harness.origin
            if keep:
                state["shellOrigin"] = app_origin(start_app(child_core, cli, child_root, "hosty.shell"), state["childId"])
            private_json(state_path, state)
            say("Reusing the owned child, app services and untouched source fixtures.")
        if state.get("stage") not in ("fixtures-ready", "main-ready"):
            # Never re-run a partially prepared work context with fresh identities.
            state["stage"] = "fixtures-started"
            private_json(state_path, state)
            credential = child_core.request("/api/auth/credentials", {"label": "Disposable external workspace fixture", "audience": "hosty:core", "scopes": ["mcp:read", "mcp:workspaces"]})
            SECRETS.add(credential["token"])
            external = Client(child_core.origin)
            trees = prepare_group(external, credential["token"], "discard-acceptance", "Discard acceptance work", [app for app, _ in manifests])
            assert len(trees) == 2, "Same-repository apps should share a tree; the second repository needs another tree."
            retained = prepare_group(external, credential["token"], "keep-independent-work", "Preserve another workspace", [manifests[0][0]])
            unmerged = prepare_group(external, credential["token"], "unmerged-normal-cleanup", "Unmerged cleanup refusal", [manifests[0][0]], dirty=False)
            state["browserTrees"] = prepare_group(external, credential["token"], "browser-discard", "Browser discard fixture", [app for app, _ in manifests]) if keep else []
            state.update(stage="fixtures-ready", fixtureTrees=trees, retainedTrees=retained, unmergedTrees=unmerged,
                         fixtureCredentialIds=[credential["id"]])
            private_json(state_path, state)
        else:
            trees, retained, unmerged = (state[key] for key in ("fixtureTrees", "retainedTrees", "unmergedTrees"))
        live_credentials = child_core.request("/api/auth/credentials")["credentials"]
        for credential_id in state["fixtureCredentialIds"]:
            if any(item["id"] == credential_id for item in live_credentials):
                child_core.request("/api/auth/credentials/" + credential_id, method="DELETE", reviewed=True)
        live_credentials = child_core.request("/api/auth/credentials")["credentials"]
        assert not any(item["id"] in state["fixtureCredentialIds"] for item in live_credentials), "Fixture external credential is still live."
        if state.get("stage") != "main-ready":
            state["stage"] = "checks-started"
            private_json(state_path, state)
        grant_fixture_environment_permissions(child_core)
        say("Prepared dirty/untracked/ignored/unmerged multi-repository work; original external credential revoked.")
        workspace_id = trees[0]["workspaceId"]
        route = "/api/development-workspaces/" + workspace_id
        if state.get("stage") != "main-ready":
            original = fixtures / "repository-1/README.md"
            app_data = child_root / "apps/test.discard.one/data/preserve.txt"
            app_data.parent.mkdir(parents=True, exist_ok=True)
            app_data.write_text("Preserve ordinary installed-app data.\n")
            protected = {str(path): data_hash(path) for path in (original, app_data, Path(retained[0]["path"]) / "README.md")}
            workspace_id = trees[0]["workspaceId"]
            route = "/api/development-workspaces/" + workspace_id
            resource = child_core.request("/api/core-environments", {"requestId": str(uuid.uuid4()), "label": "Discard owned test data", "mode": "current", "context": {"workspaceId": workspace_id}})
            resource = child_core.request(f"/api/core-environments/{resource['id']}/operations/start", {"requestId": str(uuid.uuid4()), "expectedRevision": resource["revision"]})
            assert resource["state"] == "running"
            resource_root = Path(resource["dataRoot"])
            assert resource_root.resolve().is_relative_to(child_root.resolve())
            resource_sentinel = resource_root / "discard-test-data.txt"
            resource_sentinel.write_text("Remove only this owned temporary test data.\n")
            state["resource"] = {"id": resource["id"], "root": str(resource_root), "port": resource["port"]}
            private_json(state_path, state)
            workflow = harness.request(route + "/workflow")
            expect_refusal(lambda: harness.request(route + "/workflow/complete", {"requestId": str(uuid.uuid4()), "expectedRevision": workflow["revision"]}), {"workspace_dirty"})
            expect_refusal(lambda: harness.request(route + "/workflow/delete", {"requestId": str(uuid.uuid4()), "expectedRevision": workflow["revision"]}), {"workspace_not_completed"})
            unmerged_route = "/api/development-workspaces/" + unmerged[0]["workspaceId"]
            unmerged_workflow = harness.request(unmerged_route + "/workflow")
            expect_refusal(lambda: harness.request(unmerged_route + "/workflow/complete", {"requestId": str(uuid.uuid4()), "expectedRevision": unmerged_workflow["revision"]}), {"workspace_unmerged"})
            unmerged_plan = harness.request(unmerged_route + "/discard/plan")
            unmerged_command = {"requestId": str(uuid.uuid4()), "expectedRevision": unmerged_plan["revision"], "digest": unmerged_plan["digest"], "confirmationName": unmerged_plan["name"]}
            assert harness.request(unmerged_route + "/discard/apply", unmerged_command)["state"] == "removed"
            assert_removed(child_root, unmerged)
            state.update(stage="main-ready", protected=protected)
            private_json(state_path, state)
        else:
            protected = state["protected"]
            resource = child_core.request("/api/core-environments/" + state["resource"]["id"])
            resource_root = Path(resource["dataRoot"])
            resource_sentinel = resource_root / "discard-test-data.txt"
        plan = harness.request(route + "/discard/plan")
        assert not plan["blockers"], "Fresh idle fixture unexpectedly has discard blockers."
        assert len(plan["trees"]) == 2
        assert any(item["id"] == resource["id"] for item in plan["resources"]), "The review omitted owned temporary test data."
        metadata_before = {name: set(path.name for path in (child_root / "core/development" / name).glob("*.json")) for name in ("workflows", "cleanup", "deletions")}
        for tree in plan["trees"]:
            assert tree["changedFiles"] and tree["untrackedFiles"] and tree["ignoredFiles"] and tree["unmergedCommits"] > 0
        command = {"requestId": str(uuid.uuid4()), "expectedRevision": plan["revision"], "digest": plan["digest"], "confirmationName": plan["name"]}
        expect_refusal(lambda: harness.request(route + "/discard/apply", {**command, "requestId": str(uuid.uuid4()), "confirmationName": "Wrong workspace"}))
        stale = Path(trees[0]["path"]) / "README.md"
        head = git(stale.parent, "rev-parse", "HEAD")
        stale.write_text("New dirty bytes after review, with identical HEAD.\n")
        expect_refusal(lambda: harness.request(route + "/discard/apply", command))
        assert git(stale.parent, "rev-parse", "HEAD") == head and stale.exists()
        assert resource_sentinel.read_text() == "Remove only this owned temporary test data.\n", "Stale review removed temporary data before admission."
        plan = harness.request(route + "/discard/plan")
        command = {"requestId": str(uuid.uuid4()), "expectedRevision": plan["revision"], "digest": plan["digest"], "confirmationName": plan["name"]}
        state.update(discardRoute=route, discardCommand=command, discardedTrees=trees)
        private_json(state_path, state)
        # Lock only the disposable second branch: Git removes its worktree before attempting
        # update-ref. This yields a real partial cleanup failure without corrupting Core journals.
        ordered = sorted(trees, key=lambda tree: tree["id"])
        fault = Path(ordered[1]["fixtureCommon"]) / "refs/heads" / (ordered[1]["branch"] + ".lock")
        fault.parent.mkdir(parents=True, exist_ok=True)
        with fault.open("x") as stream:
            stream.write("Disposable acceptance branch-removal fault.\n")
        try:
            try:
                harness.request(route + "/discard/apply", command)
            except ApiError as error:
                if error.status not in (409, 500, 503):
                    raise
            progress = harness.request(route + "/discard/status?requestId=" + command["requestId"])
            assert progress["state"] == "pending", "The injected cleanup failure lost its pending receipt."
            assert any(not Path(tree["path"]).exists() for tree in trees), "The fault did not interrupt physical cleanup."
        finally:
            fault.unlink()
        say("Observed partial physical cleanup; restarting only the owned child through its parent.")
        child = parent.request(f"/api/core-environments/{state['childId']}")
        restart = {"requestId": str(uuid.uuid4()), "expectedRevision": child["revision"]}
        state["restartRequest"] = restart
        private_json(state_path, state)
        child = parent.request(f"/api/core-environments/{state['childId']}/operations/restart", restart)
        assert child["state"] == "running"
        child_core = Client(child["previewUrl"], child_root)
        child_core.login(password)
        harness_app = start_app(child_core, cli, child_root, "hosty.harness")
        harness = Client(app_origin(harness_app, state["childId"]))
        authorize_app(child_core, harness)
        state["harnessOrigin"] = harness.origin
        if keep:
            state["shellOrigin"] = app_origin(start_app(child_core, cli, child_root, "hosty.shell"), state["childId"])
        private_json(state_path, state)
        assert harness.request(route + "/discard/status?requestId=" + command["requestId"])["state"] == "pending"
        progress = harness.request(route + "/discard/apply", command)
        assert progress["state"] == "removed", "Original-request recovery did not confirm physical removal."
        assert_removed(child_root, trees)
        assert not resource_root.exists() and not listening(resource["port"]), "Owned temporary Core/data remains after discard."
        for name, before in metadata_before.items():
            assert set(path.name for path in (child_root / "core/development" / name).glob("*.json")) == before, "Discard left lifecycle/cleanup metadata."
        assert harness.request(route + "/discard/status?requestId=" + command["requestId"])["state"] == "removed"
        assert harness.request(route + "/discard/apply", command)["state"] == "removed"
        assert_removed(child_root, trees)
        assert all(data_hash(path) == value for path, value in protected.items()), "Source outside the discarded trees or ordinary app data changed."
        assert Path(retained[0]["path"]).is_dir()
        state["apiPassed"] = True
        private_json(state_path, state)
        say("PASS: normal-login Harness API refused normal cleanup, rejected stale dirty review, removed exact trees/branches/registrations/metadata, and replayed original removal receipt.")
        say("PASS: injected branch-removal failure survived child restart and recovered with the identical UUID/review/body.")
        say("PASS: the reviewed temporary child Core and its synthetic data were physically removed.")
        say("PASS: shared Git caches, another workspace, original source and installed-app data remain unchanged.")
        success = True
        if keep:
            say("Retained disposable browser stand: " + str(state_path))
            say("Private test-login credentials: " + str(base / "credentials.json"))
            say("Child Core: " + child_core.origin + "; Harness: " + harness.origin + "; Shell: " + state["shellOrigin"])
            say("Browser fixture: Browser discard fixture; finish with --finish-state " + str(state_path))
    except BaseException as error:
        say("Acceptance failed: " + str(error))
        say("Retaining owned diagnostic stand: " + str(state_path))
        raise
    finally:
        if success and not keep:
            finish_stand(state_path)
        elif not success:
            say("Inspect/finish only this owned stand; no live-instance cleanup was attempted.")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("workspace", nargs="?", default=".")
    parser.add_argument("--keep", action="store_true")
    parser.add_argument("--core-binary", help="Exact built native Core apphost for the disposable parent; the child builds the selected worktree project.")
    parser.add_argument("--cli-binary", help="Exact built native CLI used only against this disposable stand.")
    parser.add_argument("--resume-state", help="Reuse an owned pre-admission fixture checkpoint without recreating workspaces.")
    parser.add_argument("--finish-state")
    args = parser.parse_args()
    if args.finish_state:
        finish_stand(args.finish_state)
    else:
        acceptance(args.workspace, args.keep, args.core_binary, args.cli_binary, args.resume_state)


if __name__ == "__main__":
    main()
