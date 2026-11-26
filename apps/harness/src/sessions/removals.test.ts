import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { SessionRemovals } from "./removals.js";

it("resumes the original confirmed removal after restart, retaining ownership and backoff", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "harness-delete-"));
  let jobs = new SessionRemovals(directory);
  try {
    jobs.accept("selected", "alice", "first-request");
    jobs.accept("selected", "alice", "second-request");
    expect(() => jobs.accept("selected", "bob", "stale-request")).toThrow("different owner");
    jobs.defer("selected", "provider_unavailable", 1000);
    jobs.close();
    jobs = new SessionRemovals(directory);
    expect(jobs.due(1999)).toEqual([]);
    expect(jobs.due(2000)).toMatchObject([{ sessionId: "selected", owner: "alice", requestId: "first-request" }]);
    jobs.completed("selected");
    jobs.defer("selected", "stale_callback", 3000);
    jobs.accept("selected", "alice", "another-request");
    expect(jobs.due(99999)).toEqual([]);
    expect(jobs.read("selected")).toMatchObject({ state: "removed", reason: null, requestId: "first-request" });
    expect(jobs.read("sibling")).toBeUndefined();
  } finally {
    jobs.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
