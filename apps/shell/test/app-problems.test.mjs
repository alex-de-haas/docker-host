import assert from "node:assert/strict";
import test from "node:test";
import { collectAppProblems } from "../src/app/shell/app-problems.ts";

// Minimal shape collectAppProblems reads; everything else on CoreApp is irrelevant to it.
function app(overrides = {}) {
  return {
    id: "com.example.app",
    displayName: "App",
    version: "1.0.0",
    capabilities: [],
    runtimeState: "stopped",
    operationStatus: "installed",
    ...overrides,
  };
}

function endpoint(key, availability, service) {
  return { key, protocol: "http", public: false, service, port: key, availability };
}

test("a healthy app reports nothing", () => {
  assert.deepEqual(collectAppProblems(app({ runtimeState: "running" })), []);
});

test("lastError is reported as an error carrying the message", () => {
  // The whole point: before this, the text existed on the record but was never rendered anywhere.
  const problems = collectAppProblems(app({ lastError: "container exited with code 1" }));
  assert.equal(problems.length, 1);
  assert.equal(problems[0].severity, "error");
  assert.equal(problems[0].detail, "container exited with code 1");
});

test("an unavailable endpoint is an error naming the endpoint", () => {
  const problems = collectAppProblems(app({
    runtimeState: "running",
    endpoints: [endpoint("http", "running", "api"), endpoint("ui", "unavailable", "web")],
  }));
  assert.equal(problems.length, 1);
  assert.equal(problems[0].severity, "error");
  assert.match(problems[0].title, /A reserved host port failed to bind/);
  assert.match(problems[0].detail, /web\.ui/);
});

test("several unavailable endpoints collapse into one problem listing each", () => {
  const problems = collectAppProblems(app({
    endpoints: [endpoint("http", "unavailable", "api"), endpoint("ui", "unavailable", "web")],
  }));
  assert.equal(problems.length, 1);
  assert.match(problems[0].title, /2 reserved host ports/);
  assert.match(problems[0].detail, /api\.http, web\.ui/);
});

test("available and assigned endpoints raise nothing", () => {
  const problems = collectAppProblems(app({
    endpoints: [endpoint("http", "running", "api"), endpoint("ui", "assigned", "web")],
  }));
  assert.deepEqual(problems, []);
});

test("missing required settings warn only while the app is stopped", () => {
  const settings = [{ key: "TOKEN", required: true, secret: false, value: "" }];
  assert.equal(collectAppProblems(app({ settings })).length, 1);
  assert.equal(collectAppProblems(app({ settings }))[0].severity, "warning");
  // A running app already got past this gate, so repeating it would be noise.
  assert.deepEqual(collectAppProblems(app({ runtimeState: "running", settings })), []);
  // And an app mid-verb is being validated by Core right now: warning there would blink the icon on
  // and off on every single start. The gate is isIdle, not "!== running".
  assert.deepEqual(collectAppProblems(app({ runtimeState: "starting", settings })), []);
  assert.deepEqual(collectAppProblems(app({ runtimeState: "stopping", settings })), []);
});

test("a required secret is not judged, since its value is never sent to the client", () => {
  const settings = [{ key: "TOKEN", required: true, secret: true, value: "" }];
  assert.deepEqual(collectAppProblems(app({ settings })), []);
});

test("a rejected live manifest warns and keeps the reason", () => {
  const problems = collectAppProblems(app({ manifestError: "unknown field 'runtimes'" }));
  assert.equal(problems.length, 1);
  assert.equal(problems[0].severity, "warning");
  assert.match(problems[0].detail, /unknown field 'runtimes'/);
});

test("a failed update check is left to the row's own update marker", () => {
  // Including it here would report the same problem twice, and would report it for live-source apps
  // that have no reviewed-update path at all.
  assert.deepEqual(collectAppProblems(app({ updateCheck: { updateAvailable: false, requiresReview: false, checkedAt: "now", error: "registry unreachable" } })), []);
});

function dependency(overrides = {}) {
  return { appId: "com.haas.torrent-engine", required: true, installed: true, running: true, endpoints: [], ...overrides };
}

test("a required dependency that is not installed is an error", () => {
  const problems = collectAppProblems(app({ dependencies: [dependency({ installed: false, running: false })] }));
  assert.equal(problems.length, 1);
  assert.equal(problems[0].severity, "error");
  assert.match(problems[0].title, /Required dependency com\.haas\.torrent-engine is not installed/);
});

test("an optional dependency that is not installed is silent", () => {
  // The one row that removes a signal: not installing an optional dependency is a choice, and an icon
  // for it would train operators to ignore the icon.
  const problems = collectAppProblems(app({
    dependencies: [dependency({ required: false, installed: false, running: false })],
  }));
  assert.deepEqual(problems, []);
});

test("an installed dependency that is stopped takes its severity from `required`", () => {
  const required = collectAppProblems(app({ dependencies: [dependency({ running: false })] }));
  assert.equal(required.length, 1);
  assert.equal(required[0].severity, "error");
  assert.match(required[0].title, /Required dependency .* is not running/);

  const optional = collectAppProblems(app({ dependencies: [dependency({ required: false, running: false })] }));
  assert.equal(optional.length, 1);
  assert.equal(optional[0].severity, "warning");
  assert.match(optional[0].title, /Optional dependency .* is not running/);
});

test("a stopped dependency reports its version when one is declared", () => {
  const problems = collectAppProblems(app({ dependencies: [dependency({ running: false, version: "^0.1.0" })] }));
  assert.match(problems[0].detail, /com\.haas\.torrent-engine \(\^0\.1\.0\)/);
});

test("a running dependency with an unresolvable wired endpoint warns and names the env var", () => {
  // The dependency itself is healthy; the wiring is not — the consumer just never receives the URL.
  const problems = collectAppProblems(app({
    dependencies: [dependency({ endpoints: [{ endpointKey: "control", alias: "torrent-ctl", resolved: false }] })],
  }));
  assert.equal(problems.length, 1);
  assert.equal(problems[0].severity, "warning");
  assert.match(problems[0].title, /Dependency endpoint com\.haas\.torrent-engine\/control is unavailable/);
  assert.match(problems[0].detail, /HOSTY_DEPENDENCY_TORRENT_CTL_URL/);
});

test("a running dependency with resolved endpoints is silent", () => {
  const problems = collectAppProblems(app({
    dependencies: [dependency({ endpoints: [{ endpointKey: "control", alias: "ctl", resolved: true }] })],
  }));
  assert.deepEqual(problems, []);
});

test("a stopped dependency is not also reported as unresolved wiring", () => {
  // Core reports every endpoint as unresolved while the provider is down; reporting both would be two
  // icons for one cause.
  const problems = collectAppProblems(app({
    dependencies: [dependency({ running: false, endpoints: [{ endpointKey: "control", alias: "ctl", resolved: false }] })],
  }));
  assert.equal(problems.length, 1);
  assert.match(problems[0].title, /is not running/);
});

test("an older Core that sends no dependencies raises nothing", () => {
  assert.deepEqual(collectAppProblems(app({ runtimeState: "running" })), []);
  assert.deepEqual(collectAppProblems(app({ runtimeState: "running", dependencies: null })), []);
});

test("problems accumulate, errors ahead of warnings", () => {
  const problems = collectAppProblems(app({
    lastError: "boom",
    manifestError: "bad manifest",
    endpoints: [endpoint("http", "unavailable", "api")],
  }));
  assert.deepEqual(problems.map((problem) => problem.severity), ["error", "error", "warning"]);
});
