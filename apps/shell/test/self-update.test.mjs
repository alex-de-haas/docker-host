import assert from "node:assert/strict";
import test from "node:test";
import { waitForShellUpdateToSettle } from "../src/app/shell/self-update.ts";

const SHELL_ID = "com.haas.shell";
const CORE_ORIGIN = "http://127.0.0.1:7070";

// Stands in for the Core event stream: records the subscription, runs the initial sync the real
// client performs on connect, and lets a test deliver further hints one at a time.
function fakeStream() {
  let onSync = null;
  const state = { unsubscribed: 0, pending: Promise.resolve() };
  const subscribe = (sync) => {
    onSync = sync;
    // subscribeToCoreEvents syncs immediately on subscribe, before the first hint.
    state.pending = Promise.resolve(sync());
    return () => {
      state.unsubscribed += 1;
    };
  };

  return {
    subscribe,
    /** Deliver one `app.changed` hint and wait for the read it triggers. */
    hint: () => Promise.resolve(onSync()),
    connected: () => state.pending,
    unsubscribes: () => state.unsubscribed,
  };
}

// Each entry answers one GET /api/apps: an app list, a status, or an Error to throw.
function stubFetch(answers) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const answer = answers.shift() ?? { apps: [] };
    if (answer instanceof Error) {
      throw answer;
    }

    if (typeof answer === "number") {
      return { ok: false, status: answer, json: async () => ({}) };
    }

    return { ok: true, status: 200, json: async () => answer };
  };

  return { calls, restore: () => { globalThis.fetch = original; } };
}

function shell(overrides = {}) {
  return { id: SHELL_ID, displayName: "Shell", version: "1.0.0", operationStatus: "updating", runtimeState: "running", ...overrides };
}

/** Resolves to the outcome, or to "pending" when the wait has not settled yet. */
function outcomeOrPending(promise) {
  return Promise.race([promise, new Promise((resolve) => setImmediate(() => resolve("pending")))]);
}

test("stays pending while Core still reports the apply as updating", async () => {
  const stub = stubFetch([{ apps: [shell()] }, { apps: [shell()] }, { apps: [shell({ operationStatus: "started" })] }]);
  const stream = fakeStream();
  try {
    const wait = waitForShellUpdateToSettle({ coreOrigin: CORE_ORIGIN, shellAppId: SHELL_ID, subscribe: stream.subscribe, timeoutMs: 5_000 });
    await stream.connected();
    assert.equal(await outcomeOrPending(wait), "pending");

    // A hint that carries no flip (another app committing) must not resolve it either.
    await stream.hint();
    assert.equal(await outcomeOrPending(wait), "pending");

    await stream.hint();
    assert.deepEqual(await wait, { kind: "settled" });
    assert.equal(stream.unsubscribes(), 1);
    assert.deepEqual(stub.calls, Array(3).fill(`${CORE_ORIGIN}/api/apps`));
  } finally {
    stub.restore();
  }
});

test("reports the record's error when the apply failed", async () => {
  const stub = stubFetch([
    { apps: [shell()] },
    { apps: [shell({ operationStatus: "failed", lastError: "pull failed: no such image" })] },
  ]);
  const stream = fakeStream();
  try {
    const wait = waitForShellUpdateToSettle({ coreOrigin: CORE_ORIGIN, shellAppId: SHELL_ID, subscribe: stream.subscribe, timeoutMs: 5_000 });
    await stream.connected();
    await stream.hint();
    assert.deepEqual(await wait, { kind: "failed", message: "pull failed: no such image" });
  } finally {
    stub.restore();
  }
});

test("a failed read is not an outcome; the next hint decides", async () => {
  const stub = stubFetch([
    new Error("network down"),
    503,
    { apps: [shell({ operationStatus: "updated" })] },
  ]);
  const stream = fakeStream();
  try {
    const wait = waitForShellUpdateToSettle({ coreOrigin: CORE_ORIGIN, shellAppId: SHELL_ID, subscribe: stream.subscribe, timeoutMs: 5_000 });
    await stream.connected();
    assert.equal(await outcomeOrPending(wait), "pending");
    await stream.hint();
    assert.equal(await outcomeOrPending(wait), "pending");
    await stream.hint();
    assert.deepEqual(await wait, { kind: "settled" });
  } finally {
    stub.restore();
  }
});

test("stops waiting when the Shell app is gone from the list", async () => {
  const stub = stubFetch([{ apps: [] }]);
  const stream = fakeStream();
  try {
    const wait = waitForShellUpdateToSettle({ coreOrigin: CORE_ORIGIN, shellAppId: SHELL_ID, subscribe: stream.subscribe, timeoutMs: 5_000 });
    assert.deepEqual(await wait, { kind: "unresolved" });
    assert.equal(stream.unsubscribes(), 1);
  } finally {
    stub.restore();
  }
});

test("gives up on the deadline without reloading, and unsubscribes", async () => {
  const stub = stubFetch([{ apps: [shell()] }]);
  const stream = fakeStream();
  try {
    const wait = waitForShellUpdateToSettle({ coreOrigin: CORE_ORIGIN, shellAppId: SHELL_ID, subscribe: stream.subscribe, timeoutMs: 20 });
    assert.deepEqual(await wait, { kind: "unresolved" });
    assert.equal(stream.unsubscribes(), 1);
  } finally {
    stub.restore();
  }
});
