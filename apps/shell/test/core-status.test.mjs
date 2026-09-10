import assert from "node:assert/strict";
import test from "node:test";
import { readCoreStatus, reconcileCoreUpdate } from "../src/app/shell/core-status.ts";
import { subscribeToCoreEvents } from "../src/app/shell/events/core-event-stream.ts";

const origin = "http://core.test";
const core = (version) => ({ component: "hosty-core", status: "running", version });

test("a reconnect refreshes the displayed Core version after a restart, including a failed interim read", async (t) => {
  const answers = [core("0.98.0"), new Error("Core restarting"), 503, core("0.99.0")];
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options });
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return { ok: typeof answer !== "number", json: async () => answer };
  });
  class FakeEventSource {
    static CLOSED = 2;
    static current;
    constructor() { FakeEventSource.current = this; }
    addEventListener() {}
    close() {}
  }
  const originals = Object.fromEntries(["window", "document", "EventSource"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, {
    window: {},
    document: { addEventListener() {}, removeEventListener() {} },
    EventSource: FakeEventSource,
  });
  let displayed = null;
  let pending;
  const unsubscribe = subscribeToCoreEvents(origin, {
    names: [],
    onSync: () => (pending = readCoreStatus(origin).then(status => { if (status) displayed = status; })),
  });
  // runSync's continuation must finish as well as the underlying read before the next reconnect.
  const settle = async () => { await pending; await new Promise(resolve => setImmediate(resolve)); };
  try {
    await settle();
    assert.equal(displayed.version, "0.98.0");
    for (const expected of ["0.98.0", "0.98.0", "0.99.0"]) {
      FakeEventSource.current.onopen();
      await settle();
      assert.equal(displayed.version, expected);
    }
    assert.equal(requests.length, 4);
    assert.ok(requests.every(({ url, options }) => url === `${origin}/api/core/status`
      && options.cache === "no-store" && options.credentials === "include"));
  } finally {
    unsubscribe();
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test("a late response after cancellation cannot overwrite Core status", async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => { controller.abort(); return core("0.98.0"); },
  }));
  assert.equal(await readCoreStatus(origin, controller.signal), null);
});

for (const statusFirst of [true, false]) {
  test(`an old Core offer is hidden when installed status arrives ${statusFirst ? "before" : "after"} a failed release check`, () => {
    let version = "0.98.0";
    let update = { currentVersion: version, availableVersion: "0.99.0", updateAvailable: true, releaseTag: "stable", checkedAt: "2026-09-10T09:00:00Z" };
    const failCheck = () => { update = { ...update, error: "HTTP 503" }; };
    if (statusFirst) version = "0.99.0";
    failCheck();
    if (!statusFirst) {
      assert.equal(reconcileCoreUpdate(update, version).updateAvailable, true);
      version = "0.99.0";
    }
    const displayed = reconcileCoreUpdate(update, version);
    assert.equal(displayed.currentVersion, version);
    assert.equal(displayed.updateAvailable, false);
    assert.equal(displayed.availableVersion, null);
    assert.equal(displayed.lastSuccessfulCheckAt, null);
    assert.equal(displayed.error, "HTTP 503");
    const fresh = { ...update, currentVersion: version, availableVersion: "0.100.0", error: null };
    assert.equal(reconcileCoreUpdate(fresh, version), fresh);
  });
}
