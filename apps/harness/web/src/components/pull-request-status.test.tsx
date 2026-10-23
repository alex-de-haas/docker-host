// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { PullRequest } from "@/lib/development-api";
import { PullRequestStatus } from "./pull-request-status";
const request = (states: string[] | undefined, override: Partial<NonNullable<PullRequest["observation"]>> = {}): PullRequest => ({ url: "https://example.test/repo/pull/1", observation: { at: new Date().toISOString(), state: "open", draft: false, unresolvedThreads: 3, reviewDecision: "CHANGES_REQUESTED", checks: states?.map(state => ({ name: state, state })), ...override } });
function render(pr: PullRequest, stale = false) { const node = document.createElement("div"); node.innerHTML = renderToStaticMarkup(<PullRequestStatus pr={pr} stale={stale} />); return node.querySelector('[role="img"]')!; }
it.each([
  [["SUCCESS", "SKIPPED", "NEUTRAL"], "CI passed", "text-success-foreground"],
  [["SUCCESS", "IN_PROGRESS"], "CI 1 of 2 · 1 running", "text-info-foreground"],
  [["PENDING"], "CI 0 of 1 · 1 running", "text-info-foreground"],
  [["SUCCESS", "FAILURE", "IN_PROGRESS"], "CI 1 failed", "text-destructive-foreground"],
  [["CANCELLED"], "CI 1 failed", "text-destructive-foreground"],
  [["UNRECOGNIZED"], "CI unknown", "text-muted-foreground"],
  [["SKIPPED"], "CI skipped", "text-muted-foreground"],
  [[], "No CI checks", "text-muted-foreground"],
  [undefined, "CI unknown", "text-muted-foreground"],
] as const)("uses the PR shape with whole-icon current CI color for %j", (states, label, color) => { const icon = render(request(states ? [...states] : undefined)); expect(icon.getAttribute("aria-label")).toBe(`Open pull request · ${label}`); expect(icon.classList.contains(color)).toBe(true); expect(icon.querySelector('.lucide-git-pull-request')).not.toBeNull(); });
it("keeps draft and closed neutral, merged violet, and does not color review decisions as CI", () => {
  const draft = render(request(["FAILURE"], { draft: true })); expect(draft.classList.contains("text-muted-foreground")).toBe(true); expect(draft.querySelector('.lucide-git-pull-request-draft')).not.toBeNull();
  const closed = render(request(["FAILURE"], { state: "closed" })); expect(closed.classList.contains("text-muted-foreground")).toBe(true); expect(closed.querySelector('.lucide-git-pull-request-closed')).not.toBeNull();
  const merged = render(request(["FAILURE"], { state: "merged" })); expect(merged.classList.contains("text-violet-600")).toBe(true); expect(merged.querySelector('.lucide-git-merge')).not.toBeNull();
  expect(render(request(["SUCCESS"], { reviewDecision: "CHANGES_REQUESTED" })).classList.contains("text-success-foreground")).toBe(true);
});
it("does not present stale, incomplete or unavailable CI as current success", () => {
  for (const [pr, stale] of [[request(["SUCCESS"]), true], [request(["SUCCESS"], { complete: false }), false], [{ ...request(["SUCCESS"]), unavailable: "Provider unavailable" }, false], [{ ...request(["SUCCESS"]), historical: true }, false]] as const) expect(render(pr, stale).classList.contains("text-muted-foreground")).toBe(true);
  expect(render({ ...request(["SUCCESS"], { state: "merged" }), historical: true }, true).classList.contains("text-violet-600")).toBe(true);
});
