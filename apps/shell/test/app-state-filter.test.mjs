import assert from "node:assert/strict";
import test from "node:test";
import { matchesAppStateFilter } from "../src/app/shell/runtime-states.ts";

const apps = [
  { id: "running", runtimeState: "running" },
  { id: "stopped", runtimeState: "stopped" },
  { id: "starting", runtimeState: "starting" },
  { id: "stopping", runtimeState: "stopping" },
  { id: "unknown", runtimeState: "unknown" },
  { id: "failed", runtimeState: "stopped", operationStatus: "failed" },
  { id: "error", runtimeState: "running", lastError: "Probe failed" },
  { id: "missing" },
];

for (const [filter, expected] of [
  ["all", apps.map(app => app.id)],
  ["running", ["running", "error"]],
  ["transitioning", ["starting", "stopping"]],
  ["attention", ["unknown", "failed", "error"]],
]) {
  test(`${filter} includes exactly its matching apps`, () => {
    assert.deepEqual(apps.filter(app => matchesAppStateFilter(app, filter)).map(app => app.id), expected);
  });
}

test("resolved errors and completed transitions leave their filters on the next render", () => {
  const app = { runtimeState: "starting", lastError: "Previous failure" };
  assert.equal(matchesAppStateFilter(app, "attention"), true);
  assert.equal(matchesAppStateFilter(app, "transitioning"), true);
  app.runtimeState = "running";
  app.lastError = "";
  assert.equal(matchesAppStateFilter(app, "attention"), false);
  assert.equal(matchesAppStateFilter(app, "transitioning"), false);
  assert.equal(matchesAppStateFilter(app, "running"), true);
});

test("update offers survive check errors and restart requirements need attention", () => {
  assert.equal(matchesAppStateFilter({ updateCheck: { updateAvailable: true, error: "Network error" } }, "updates"), true);
  assert.equal(matchesAppStateFilter({ updateCheck: { error: "Network error" } }, "attention"), true);
  assert.equal(matchesAppStateFilter({ restartRequired: true }, "attention"), true);
  assert.equal(matchesAppStateFilter({}, "updates"), false);
});

test("search matches name and ID, ignores case/outer whitespace, and combines with status", async () => {
  const { matchesAppSearch } = await import("../src/app/shell/runtime-states.ts");
  const apps = [
    { id: "com.haas.media-server", displayName: "Media Server", updateCheck: { updateAvailable: true } },
    { id: "hosty.shell", displayName: "Hosty Shell" },
  ];
  assert.equal(matchesAppSearch(apps[0], "  MEDIA server "), true);
  assert.equal(matchesAppSearch(apps[0], "com.haas"), true);
  assert.equal(matchesAppSearch(apps[1], "  "), true);
  assert.deepEqual(apps.filter(app => matchesAppSearch(app, "media") && matchesAppStateFilter(app, "updates")), [apps[0]]);
  assert.equal(matchesAppSearch(apps[1], "unknown"), false);
});
