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

test("problems accumulate, errors ahead of warnings", () => {
  const problems = collectAppProblems(app({
    lastError: "boom",
    manifestError: "bad manifest",
    endpoints: [endpoint("http", "unavailable", "api")],
  }));
  assert.deepEqual(problems.map((problem) => problem.severity), ["error", "error", "warning"]);
});
