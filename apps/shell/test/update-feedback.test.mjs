import assert from "node:assert/strict";
import test from "node:test";
import { updateFeedback, updateCheckDescription } from "../src/app/shell/update-feedback.ts";

test("readiness is in progress; completion and unrelated actions have no row feedback", () => {
  const app = { lastOperation: "update", operationStatus: "updating", updateProgress: { stage: "checking" } };
  assert.equal(updateFeedback(app), "Checking readiness");
  app.operationStatus = "updated";
  app.updateProgress.stage = "completed";
  assert.equal(updateFeedback(app), null);
  app.operationStatus = "updating";
  assert.equal(updateFeedback(app), null);
  app.updateProgress.stage = "checking";
  app.lastOperation = "stop";
  assert.equal(updateFeedback(app), null);
});

test("stop and start belong to runtime status rather than the update detail", () => {
  for (const stage of ["stopping", "starting"]) {
    const app = { operationStatus: "updating", lastOperation: "update", updateProgress: { stage, service: "web" } };
    assert.equal(updateFeedback(app), "Updating");
    assert.equal(updateFeedback({ ...app, operationStatus: "failed" }), null);
    assert.equal(updateFeedback({ ...app, lastOperation: "restart" }), null);
  }
});

test("failed check retains the found update and names the last successful check", () => {
  const verdict = { updateAvailable: true, checkedAt: "2026-09-10T11:00:00Z", lastSuccessfulCheckAt: "2026-09-10T10:00:00Z", error: "Offline" };
  const text = updateCheckDescription(verdict);
  assert.match(text, /failed: Offline/);
  assert.match(text, /previously found update/);
  assert.ok(text.includes(new Date(verdict.lastSuccessfulCheckAt).toLocaleString()));
  assert.doesNotMatch(text, /No updates found/);
});

test("never checked, failure without a result, and successful empty checks stay distinct", () => {
  assert.match(updateCheckDescription(null), /not been checked/);
  const verdict = { updateAvailable: false, checkedAt: "2026-09-10T10:00:00Z", error: "Offline" };
  assert.match(updateCheckDescription(verdict), /No successful check yet/);
  assert.match(updateCheckDescription({ ...verdict, error: null }), /No updates found/);
});

test("older Core progress falls back honestly and terminal outcomes have no row feedback", () => {
  assert.equal(updateFeedback({ operationStatus: "updating" }), "Updating");
  for (const stage of ["completed", "needs-attention", "failed", "interrupted"]) {
    const app = { lastOperation: "update", operationStatus: "updated", updateProgress: { stage } };
    assert.equal(updateFeedback(app), null);
    assert.equal(updateFeedback({ ...app, operationStatus: "updating" }), null);
  }
});

test("bulk update excludes retained offers after failures, review requirements and running operations", async () => {
  const { isRoutineUpdate } = await import("../src/app/shell/update-feedback.ts");
  const app = { operationStatus: "started", updateCheck: { updateAvailable: true, planDigest: "reviewed", requiresReview: false } };
  assert.equal(isRoutineUpdate(app), true);
  for (const check of [{ error: "Offline" }, { requiresReview: true }, { planDigest: null }, { updateAvailable: false }]) {
    assert.equal(isRoutineUpdate({ ...app, updateCheck: { ...app.updateCheck, ...check } }), false);
  }
  assert.equal(isRoutineUpdate({ ...app, operationStatus: "updating" }), false);
});
