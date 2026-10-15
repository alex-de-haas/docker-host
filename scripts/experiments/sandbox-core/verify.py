#!/usr/bin/env python3
"""Exercise a Core-managed QA app through normal password login and app PKCE.

Use an isolated Core and a private JSON credentials file with email/password fields.
The default run verifies allocation, users, data and disposal without starting Docker.
--runtime adds app start, private browser verification and evidence export.
--background additionally uses an explicitly created, digest-bound background grant.
No credentials or cookies are written to the evidence directory.
"""
import argparse
import base64
import hashlib
import http.cookiejar
import json
import secrets
import socket
import stat
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path


class ApiError(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code
        super().__init__(f"HTTP {status}: {code}")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["core-origin", "app-origin", "data-root", "credentials-file", "output-dir"]:
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--background", action="store_true")
    parser.add_argument("--runtime", action="store_true")
    args = parser.parse_args()
    for origin in [args.core_origin, args.app_origin]:
        parsed = urllib.parse.urlsplit(origin)
        if parsed.scheme != "http" or not (parsed.hostname or "").endswith(".hosty.localhost") or parsed.path or parsed.query or parsed.fragment or parsed.username:
            raise ValueError("Use exact managed local test origins without paths or credentials.")
    credentials_path = Path(args.credentials_file)
    if credentials_path.stat().st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise ValueError("The credentials file must be private to its owner.")
    output = Path(args.output_dir); output.mkdir(parents=True, exist_ok=True); output.chmod(0o700)
    data_root = Path(args.data_root)
    if (data_root / "core/development").exists():
        raise ValueError("Use a test Core without a pre-existing development directory for this acceptance case.")
    resolve = socket.getaddrinfo
    socket.getaddrinfo = lambda host, *a, **kw: resolve("127.0.0.1" if host and host.endswith(".localhost") else host, *a, **kw)
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(jar), NoRedirect())

    def save(name, body):
        target = output / name; target.write_text(json.dumps(body, indent=2) + "\n"); target.chmod(0o600)

    def request(origin, path, body=None, method=None, headers=None, form=False):
        hdr = {"Origin": origin, "Content-Type": "application/x-www-form-urlencoded" if form else "application/json", **(headers or {})}
        csrf = next((cookie.value for cookie in jar if cookie.name == "hosty_csrf"), None)
        if csrf: hdr["X-Hosty-CSRF"] = csrf
        encoded = (urllib.parse.urlencode(body) if form else json.dumps(body)).encode() if body is not None else None
        req = urllib.request.Request(origin + path, data=encoded, headers=hdr, method=method)
        try:
            with opener.open(req, timeout=360) as response: raw = response.read()
        except urllib.error.HTTPError as error:
            if form and path == "/login" and error.code == 302: return None
            try: code = json.loads(error.read()).get("code", "unreadable_error")
            except (ValueError, AttributeError): code = "unreadable_error"
            raise ApiError(error.code, code) from None
        return json.loads(raw) if raw else None

    def login():
        credentials = json.loads(credentials_path.read_text())
        request(args.core_origin, "/login", {"email": credentials["email"], "password": credentials["password"]}, form=True)
        request(args.core_origin, "/api/auth/csrf")
        verifier = secrets.token_urlsafe(48)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
        code = request(args.core_origin, "/api/auth/apps/authorize", {"appId": "hosty.sandbox-qa-fixture", "redirectUri": args.app_origin + "/callback", "codeChallenge": challenge, "codeChallengeMethod": "S256"})
        return request(args.app_origin, "/api/app-code", {"code": code["code"], "codeVerifier": verifier})["accessToken"]

    token = login()
    background = None

    def qa(action, body):
        return request(args.app_origin, "/api/sandbox", {"action": action, "input": body, **({"background": background} if background else {})}, headers={"Authorization": "Bearer " + token})

    def command(view, action, **extra):
        payload = {"runtimeInstanceId": view["id"], "requestId": str(uuid.uuid4()), "expectedRevision": view["revision"], **extra}
        save("pending-operation.json", {"action": action, "input": payload})
        current = qa("sandbox-" + action, payload)
        deadline = time.monotonic() + 780
        while True:
            operation = next((item for item in current["operations"] if item["id"] == payload["requestId"]), None)
            if operation and operation["state"] == "succeeded": return current, payload
            if operation and operation["state"] in ("failed", "unknown"):
                raise ApiError(409, operation.get("errorCode", "sandbox_operation_unknown"))
            if time.monotonic() >= deadline: raise TimeoutError("Keep pending-operation.json and inspect the original operation before retrying.")
            time.sleep(1)
            current = qa("sandbox-status", {"runtimeInstanceId": view["id"]})

    plan_input = {"appId": "com.haas.demo-app", "profile": "sandbox-artifact", "source": {"kind": "appArtifact"}}
    plan = qa("sandbox-plan", plan_input)
    if plan["blockers"]: raise ValueError("Review and approve the sandbox recipe before running this fixture.")
    grant = None
    instance = None
    report = {"source": "appArtifact", "background": args.background, "runtimeRequested": args.runtime, "runtimeVerified": False}
    try:
        if args.background:
            grant = request(args.core_origin, "/api/auth/background-grants", {"appId": "hosty.sandbox-qa-fixture", "label": "Isolated sandbox acceptance",
                "scopes": [{"id": "qa", "kind": "sandbox", "targetAppId": "com.haas.demo-app", "actions": ["plan", "prepare", "read", "users", "seed", "reset", "start", "stop", "dispose", "browser", "export"],
                    "sandbox": {"inputDigest": plan["inputDigest"], "limits": plan["request"]["limits"]}}]})
            background = {"grantId": grant["id"], "scopeId": "qa"}
            try:
                qa("sandbox-plan", {**plan_input, "source": {"kind": "appArtifact", "artifactDigest": "0" * 64}})
                raise AssertionError("Background scope accepted unrelated inputs.")
            except ApiError as error:
                if error.status != 403: raise
            plan_input["source"]["artifactDigest"] = plan["inputDigest"]
            plan = qa("sandbox-plan", plan_input)
        prepare = {"requestId": str(uuid.uuid4()), "planId": plan["id"], "digest": plan["digest"]}
        save("prepare-request.json", prepare)
        instance = qa("sandbox-prepare", prepare)
        save("prepared.json", instance)
        assert qa("sandbox-prepare", prepare)["id"] == instance["id"]
        assert instance["source"]["kind"] == "appArtifact" and not instance.get("context")
        assert not (data_root / "core/development").exists()
        report["allocationReplay"] = True; report["noWorkspace"] = True
        base = {"runtimeInstanceId": instance["id"]}
        instance = qa("sandbox-users", {**base, "requestId": str(uuid.uuid4()), "expectedRevision": instance["revision"], "fixtureKey": "admin", "displayName": "Temporary QA administrator", "role": "admin", "permissions": ["demo.people.read"]})
        first_user = instance["users"][0]["id"]
        seed = str(uuid.uuid4())
        instance = qa("sandbox-seed", {**base, "requestId": seed, "expectedRevision": instance["revision"], "files": [{"path": "qa-fixture.json", "content": '{"owner":"{{sandbox.user.admin}}"}'}]})
        instance, _ = command(instance, "reset", seedRevision=seed.replace("-", ""))
        assert instance["users"][0]["id"] != first_user
        seeded = json.loads((data_root / "sandboxes" / instance["id"] / "data/qa-fixture.json").read_text())
        assert seeded["owner"] == instance["users"][0]["id"]
        report["resetCreatesNewUserAndExpandsSeed"] = True
        if args.runtime:
            started = time.monotonic(); instance, _ = command(instance, "start")
            report["startupSeconds"] = round(time.monotonic() - started, 3)
            browser_input = {**base, "requestId": str(uuid.uuid4()), "expectedRevision": instance["revision"], "userId": instance["users"][0]["id"], "actions": [{"kind": "navigate", "path": "/"}, {"kind": "assert-visible", "selector": "main h1"}, {"kind": "assert-text", "selector": "main h1", "value": "Demo App"}, {"kind": "screenshot"}]}
            if args.background:
                job = request(args.app_origin, "/api/jobs", {"action": "sandbox-browser", "input": browser_input, "background": background}, headers={"Authorization": "Bearer " + token})
                request(args.core_origin, "/api/auth/logout", {})
                logged_out_at = time.time() * 1000
                try:
                    qa("sandbox-status", base)
                    raise AssertionError("The logged-out interactive grant remained usable.")
                except ApiError as error:
                    if error.status not in (401, 403): raise
                time.sleep(10)
                token = login()
                deadline = time.monotonic() + 360
                while True:
                    outcome = request(args.app_origin, "/api/jobs/" + job["id"], headers={"Authorization": "Bearer " + token})
                    if outcome["state"] in ("succeeded", "failed"): break
                    if time.monotonic() >= deadline: raise TimeoutError("Retain the background job ID and inspect before replay.")
                    time.sleep(1)
                assert outcome["startedAt"] > logged_out_at
                assert outcome["state"] == "succeeded", outcome.get("error", {}).get("code")
                run = outcome["result"]
                report["backgroundDispatchAfterLogout"] = True
            else:
                run = qa("sandbox-browser", browser_input)
            exported = qa("sandbox-export", {**base, "jobId": run["id"]})
            save("browser-evidence.json", exported)
            assert run["state"] == "passed" and not exported["stale"]
            report["runtimeVerified"] = True
            instance, _ = command(qa("sandbox-status", base), "stop")
        if args.background:
            request(args.core_origin, "/api/auth/background-grants/" + grant["id"], method="DELETE")
            try:
                qa("sandbox-status", base)
                raise AssertionError("Revoked background grant remained usable.")
            except ApiError as error:
                if error.status not in (401, 403): raise
            report["revocationDenied"] = True
            background = None
        instance, disposal = command(qa("sandbox-status", base), "dispose")
        assert qa("sandbox-dispose", disposal)["state"] == "disposed"
        assert not (data_root / "sandboxes" / instance["id"]).exists()
        assert not (data_root / "core/sandboxes/instances" / instance["id"]).exists()
        assert not (data_root / "core/development").exists()
        report["disposalReplay"] = True; report["temporaryResourcesRemoved"] = True
        report["state"] = "passed"; save("evidence.json", report)
        print(json.dumps(report))
    except Exception as error:
        report["state"] = "failed"; report["error"] = error.code if isinstance(error, ApiError) else type(error).__name__
        save("evidence.json", report)
        raise
    finally:
        # Only this run's allocation/grant is eligible for cleanup. Existing instances are untouched.
        background = None
        if instance and instance.get("state") != "disposed":
            try:
                current = qa("sandbox-status", {"runtimeInstanceId": instance["id"]})
                command(current, "dispose")
            except Exception:
                save("cleanup-required.json", {"instanceId": instance["id"], "instruction": "Read current state and replay the retained operation before any retry."})
        if grant:
            request(args.core_origin, "/api/auth/background-grants/" + grant["id"], method="DELETE")


if __name__ == "__main__":
    main()
