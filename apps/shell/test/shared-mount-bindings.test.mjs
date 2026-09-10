import assert from "node:assert/strict";
import test from "node:test";
import { assignedMountKeys, assignmentChanges, mountAssignments, mountSlotConflict, sharedMountMode, sharedMountPath, saveMountAssignments, acceptSavedAssignments } from "../src/app/shell/shared-mount-bindings.ts";

const slot = (key, bindings = [], multiple = true) => ({ key, bindings, multiple, mode: "rw", required: false });
const global = name => ({ label: name, globalMountName: name, hostPath: "/host/media" });

test("usage matches references, not inline paths or coincidentally equal labels", () => {
  const apps = [{ id: "media", mounts: [slot("roots", [global("disk")]), slot("inline", [{ label: "disk", hostPath: "/host/media" }]), slot("other", [global("other")])] }];
  assert.deepEqual(assignedMountKeys(apps[0], "disk"), ["roots"]);
  assert.deepEqual(mountAssignments(apps, "disk"), { media: ["roots"] });
});

test("assignment diff includes additions, removal and moves without sending unrelated bindings", () => {
  const before = { media: ["roots"], torrent: [], transcode: ["old"] };
  const after = { media: [], torrent: ["downloads"], transcode: ["new"] };
  assert.deepEqual(assignmentChanges(before, after), [
    { appId: "media", keys: [], expectedKeys: ["roots"] },
    { appId: "torrent", keys: ["downloads"], expectedKeys: [] },
    { appId: "transcode", keys: ["new"], expectedKeys: ["old"] },
  ]);
  assert.deepEqual(assignmentChanges({ app: ["b", "a"] }, { app: ["a", "b"] }), []);
});

test("single-slot occupancy and inline label collisions block implicit replacement", () => {
  assert.match(mountSlotConflict(slot("one", [global("other")], false), "disk"), /one folder/);
  assert.equal(mountSlotConflict(slot("one", [global("disk")], false), "disk"), null);
  assert.equal(mountSlotConflict(slot("many", [global("other")]), "disk"), null);
  assert.match(mountSlotConflict(slot("many", [{ label: "disk" }]), "disk"), /inline/);
});

test("paths follow the runtime and either read-only cap wins", () => {
  const mount = { name: "disk", hostPath: "/host/media", mode: "rw" };
  assert.equal(sharedMountPath({ selectedRuntime: "container", runtimeProfiles: [{ key: "container", type: "docker" }] }, slot("roots"), mount), "/mnt/roots/disk");
  assert.equal(sharedMountPath({ selectedRuntime: "dev", runtimeProfiles: [{ key: "dev", type: "localCommand" }] }, slot("roots"), mount), "/host/media");
  assert.equal(sharedMountMode(slot("roots"), mount), "rw");
  assert.equal(sharedMountMode({ mode: "ro" }, mount), "ro");
  assert.equal(sharedMountMode(slot("roots"), { mode: "ro" }), "ro");
});

test("partial failure keeps successes and retries only failed apps", async () => {
  let baseline = { media: [], torrent: [], transcode: [] };
  const selected = { media: ["roots"], torrent: ["downloads"], transcode: ["inputs"] };
  const written = [];
  const results = await saveMountAssignments(assignmentChanges(baseline, selected), async change => {
    written.push(change.appId);
    if (change.appId === "torrent") throw new Error("Bindings changed");
  });
  assert.deepEqual(written, ["media", "torrent", "transcode"]);
  assert.equal(results[1].error, "Bindings changed");
  baseline = acceptSavedAssignments(baseline, results);
  assert.deepEqual(assignmentChanges(baseline, selected), [{ appId: "torrent", keys: ["downloads"], expectedKeys: [] }]);
  const retry = await saveMountAssignments(assignmentChanges(baseline, selected), async () => {});
  assert.deepEqual(assignmentChanges(acceptSavedAssignments(baseline, retry), selected), []);
});

test("an error without a message never becomes a successful assignment", async () => {
  const selected = { app: ["roots"] };
  const results = await saveMountAssignments(assignmentChanges({ app: [] }, selected), async () => { throw new Error(""); });
  assert.match(results[0].error, /failed/);
  assert.deepEqual(acceptSavedAssignments({ app: [] }, results), { app: [] });
});
