import { expect, it } from "vitest";
import { checkCounts, ciPresentation, prStateLabel } from "./pull-request-presentation";
import type { PullRequest } from "./development-api";
const pr = (states: string[]): PullRequest => ({ url: "https://github.com/example/repo/pull/7", observation: { at: "2026-10-21T20:00:00Z", state: "open", draft: false, unresolvedThreads: 0, checks: states.map(state => ({ name: state, state })) } });
it("keeps passed, skipped, pending, failed and unknown checks distinct", () => {
  expect(checkCounts(pr(["SUCCESS", "SKIPPED", "NEUTRAL", "IN_PROGRESS", "FAILURE", "FUTURE"]))).toMatchObject({ passed: 1, skipped: 2, pending: 1, failed: 1, unknown: 1, total: 6, completed: 4 });
});
it("does not present stale, historical, incomplete or all-skipped checks as current CI success", () => {
  expect(ciPresentation(pr(["SUCCESS"]), false).kind).toBe("passed");
  expect(ciPresentation({ ...pr(["SUCCESS"]), historical: true }, false)).toMatchObject({ kind: "unknown", label: "CI last observed" });
  expect(ciPresentation(pr(["SUCCESS"]), true)).toMatchObject({ kind: "unknown", label: "CI outdated" });
  expect(ciPresentation({ ...pr(["SUCCESS"]), observation: { ...pr(["SUCCESS"]).observation!, complete: false } }, false).kind).toBe("unknown");
  expect(ciPresentation(pr(["SKIPPED"]), false)).toMatchObject({ kind: "unknown", label: "CI skipped" });
});
it("never invents state or checks when observation is absent or access unavailable", () => {
  expect(ciPresentation({ url: "url" }, true).label).toBe("CI unknown");
  expect(prStateLabel({ ...pr(["SUCCESS"]), unavailable: "Access changed" })).toBe("State unknown");
  expect(checkCounts({ ...pr(["SUCCESS"]), unavailable: "Access changed" }).available).toBe(false);
});
