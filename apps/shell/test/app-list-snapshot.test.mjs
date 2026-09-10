import assert from "node:assert/strict";
import test from "node:test";
import { reconcileAppList } from "../src/app/shell/app-list-snapshot.ts";

const oldApp = { id: "demo", version: "1.0.0", sourceCommit: "old", runtimeState: "running", operationStatus: "updating", updateCheck: { updateAvailable: true } };
const newApp = { ...oldApp, version: "1.1.0", sourceCommit: "new", operationStatus: "started", updateCheck: { updateAvailable: false } };

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("a full refresh waiting for mounts cannot roll back an event-delivered app update", async () => {
  let state = { apps: [oldApp], appsReadId: 0 };
  const mounts = deferred();
  const fullRefresh = (async () => {
    const snapshot = { apps: [oldApp], updateCheck: { running: true } };
    await mounts.promise;
    state = reconcileAppList(state, snapshot, 1);
  })();
  state = reconcileAppList(state, { apps: [newApp], updateCheck: { running: false } }, 2);
  mounts.resolve();
  await fullRefresh;
  assert.deepEqual(state.apps, [newApp]);
  assert.equal(state.updateCheck.running, false);
});

test("an old event response arriving after a full refresh cannot roll back versions", () => {
  const full = reconcileAppList({ apps: [oldApp] }, { apps: [newApp] }, 2);
  const lateEvent = reconcileAppList(full, { apps: [oldApp] }, 1);
  assert.deepEqual(lateEvent.apps, [newApp]);
});

test("bulk updates preserve all versions and revisions from the newer snapshot", () => {
  const old = [oldApp, { ...oldApp, id: "second" }];
  const updated = [newApp, { ...newApp, id: "second", version: "2.0.0" }];
  const latest = reconcileAppList({ apps: old }, { apps: updated }, 5);
  assert.deepEqual(reconcileAppList(latest, { apps: old }, 4).apps, updated);
});

test("a completed later read still replaces the current snapshot, including removals", () => {
  const previous = reconcileAppList({ apps: [] }, { apps: [newApp] }, 2);
  assert.deepEqual(reconcileAppList(previous, { apps: [] }, 3).apps, []);
});
