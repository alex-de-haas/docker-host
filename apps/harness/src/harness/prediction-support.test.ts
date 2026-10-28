import { expect, it } from "vitest";
import { PredictionSupportCache } from "./prediction-support.js";
it("retries automatically after a native upgrade, expiration or process restart", () => {
  const cache = new PredictionSupportCache(100);
  const old = cache.key("/codex", "hosty-harness/0.162.1 (Linux)"), upgraded = cache.key("/codex", "hosty-harness/0.163.0 (Linux)");
  expect(cache.shouldRequest(old, 10)).toBe(true);
  expect(cache.observeFailure(old, { code: -32601, message: "thread/prediction/request is not implemented yet" }, 10)).toBe(true);
  expect(cache.shouldRequest(old, 11)).toBe(false); expect(cache.shouldRequest(upgraded, 11)).toBe(true);
  expect(cache.shouldRequest(old, 110)).toBe(true);
  expect(new PredictionSupportCache().shouldRequest(old)).toBe(true);
});
it("never turns account, model, quota, experimental or timeout failures into an unsupported runtime", () => {
  const cache = new PredictionSupportCache(); const key = cache.key("/codex", "native/1.2.3");
  for (const error of [{ code: -32000, message: "not implemented for this account" }, { code: 401, message: "Unauthorized" },
    { code: -32600, message: "Experimental API unavailable" }, { code: 429, message: "Quota" }, new Error("Timeout"), { code: -32601, message: "Other method unavailable" }]) {
    expect(cache.observeFailure(key, error)).toBe(false); expect(cache.shouldRequest(key)).toBe(true);
  }
  expect(cache.key("/codex", undefined)).toBeNull(); expect(cache.key("/codex", "native")).toBeNull();
  expect(cache.observeFailure(null, { code: -32601, message: "Method not found" })).toBe(true); expect(cache.shouldRequest(null)).toBe(true);
});
