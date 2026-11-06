// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspacePullRequest } from "./workspace-pull-request";
import type { PullRequest, Worktree } from "@/lib/development-api";
let root: Root, container: HTMLDivElement;
const now = Date.parse("2026-10-21T20:00:00Z"), url = "https://github.com/example/repo/pull/7";
const tree: Worktree = { id: "tree", workspaceId: "workspace", repository: "https://github.com/example/repo", branch: "feature", state: "active", apps: [], leases: [], pullRequests: [], observation: { at: "2026-10-21T20:00:00Z", state: "ok", head: "workspace-head", local: { files: [], truncated: false } } };
const pr = (): PullRequest => ({ url, observation: { at: "2026-10-21T20:00:00Z", state: "open", draft: false, title: "Review layout", unresolvedThreads: 2, commentCount: 3, head: "published-head", reviewDecision: "CHANGES_REQUESTED", checks: [{ name: "Build", state: "SUCCESS" }, { name: "Tests", state: "IN_PROGRESS" }, { name: "Optional", state: "SKIPPED" }] } });
const review = vi.fn(), trigger = () => container.querySelector<HTMLButtonElement>('[data-slot="pull-request-card"] > button')!;
const render = (value: PullRequest, source = tree) => act(async () => root.render(<WorkspacePullRequest tree={source} pr={value} now={now} onReview={review} />));
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); container = document.createElement("div"); document.body.append(container); root = createRoot(container); review.mockReset(); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it("collapses to two readable lines and opens exact published review without a mutation", async () => {
  await render(pr()); expect(trigger().getAttribute("aria-expanded")).toBe("false"); expect(container.textContent).toContain("Open · CI 2 of 3 · 1 running · 2 unresolved threads"); expect(container.querySelector('[aria-label="Review changes for repo #7"]')).toBeNull();
  const description = document.getElementById(trigger().getAttribute("aria-describedby")!); expect(description?.textContent).toContain("2 unresolved threads");
  await act(async () => trigger().click()); expect(container.textContent).toContain("Changes requested"); expect(container.textContent).toContain("1 passed · 1 in progress · 1 skipped"); expect(container.textContent).toContain("not all in this published PR head");
  const button = container.querySelector<HTMLButtonElement>('[aria-label="Review changes for repo #7"]')!; await act(async () => button.click()); expect(review).toHaveBeenCalledExactlyOnceWith(button);
  expect(container.querySelector<HTMLAnchorElement>('a[href="https://github.com/example/repo/pull/7"]')?.rel).toBe("noopener noreferrer");
});
it("retains expanded state and live checks as new observations arrive", async () => {
  await render(pr()); await act(async () => trigger().click());
  await render({ ...pr(), observation: { ...pr().observation!, checks: [{ name: "Build", state: "SUCCESS" }] } });
  expect(trigger().getAttribute("aria-expanded")).toBe("true"); expect(container.textContent).toContain("CI passed"); expect(container.textContent).toContain("1 passed · 0 in progress · 0 skipped");
  await act(async () => trigger().click()); expect(container.querySelector('[aria-label="Review changes for repo #7"]')).toBeNull();
});
it("shows historical merged facts with their real timestamps and cached CI, preserving inspection", async () => {
  const historical = { ...pr(), historical: true, observation: { ...pr().observation!, state: "merged", at: "2026-10-01T10:00:00Z", mergedAt: "2026-10-02T11:00:00Z" } };
  await render(historical); expect(container.textContent).toContain("Merged · CI last observed"); await act(async () => trigger().click());
  expect(container.textContent).toContain("Last observed"); expect(container.querySelector('time[datetime="2026-10-01T10:00:00Z"]')).not.toBeNull(); expect(container.querySelector('time[datetime="2026-10-02T11:00:00Z"]')).not.toBeNull();
  expect(container.textContent).toContain("Cached check results"); expect(container.textContent).toContain("Inspect published changes"); expect(container.textContent).not.toContain("not all in this published PR head");
});
it("retains GitHub links after release and does not invent an unpushed-head note from missing workspace evidence", async () => {
  await render(pr(), { ...tree, state: "released", observation: undefined }); await act(async () => trigger().click());
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Review changes for repo #7"]')?.disabled).toBe(true); expect(container.querySelector('a[href="https://github.com/example/repo/pull/7"]')).not.toBeNull(); expect(container.textContent).not.toContain("not all in this published PR head");
});

it.each(["merged", "closed"])("keeps an old %s PR and its check details as last-observed evidence", async state => {
  const value = { ...pr(), observation: { ...pr().observation!, state, at: "2026-10-01T10:00:00Z", checks: [{ name: "Tests", state: "FAILURE" }] } };
  await render(value);
  expect(container.textContent).toContain("CI last observed");
  expect(container.textContent).not.toContain("CI outdated");
  await act(async () => trigger().click());
  expect(container.textContent).toContain("1 failed");
  expect(container.textContent).toContain("Cached check results describe this observation.");
  expect(container.textContent?.toLowerCase()).not.toContain("outdated");
  expect(container.textContent).not.toContain("Refresh to observe current");
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="repo #7: CI 1/1, show checks"]')!.click());
  const checks = document.querySelector('[aria-label="repo #7: CI checks"]')!;
  expect(checks.textContent).toContain("last observed check results");
  expect(checks.textContent).toContain("Failure");
  expect(checks.textContent).not.toContain("outdated");
});

it("still warns about outdated open PR evidence", async () => {
  await render({ ...pr(), observation: { ...pr().observation!, at: "2026-10-01T10:00:00Z" } });
  expect(container.textContent).toContain("CI outdated");
  await act(async () => trigger().click());
  expect(container.textContent).toContain("Refresh to observe current PR and CI state.");
});

const completionPr = (state: string, stale = false): PullRequest => ({ ...pr(), observation: { ...pr().observation!,
  state: "merged", complete: false, at: stale ? "2026-10-21T19:55:00Z" : "2026-10-21T20:00:00Z",
  checks: [{ name: "PR build", state: "SUCCESS" }], error: "PR merged; check is missing for merge commit. Internal diagnostic.",
  completionIssue: { kind: "check", requirement: "ci-required", state, mergeCommit: "merge-sha" },
} });
it.each(["missing", "pending"])("presents %s merge CI as waiting separately from passing PR checks", async state => {
  await render(completionPr(state)); await act(async () => trigger().click());
  expect(container.textContent).toContain("Waiting for post-merge CI");
  expect(container.textContent).toContain("Pull request checks (before merge)");
  expect(container.textContent).toContain("ci-required");
  expect(container.textContent).not.toContain("Internal diagnostic");
  expect(container.querySelector('[role="status"]')?.className).not.toContain("text-destructive");
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="repo #7: CI 1/1, show checks"]')!.click());
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("Internal diagnostic");
  expect(document.querySelector('[role="dialog"] .text-destructive-foreground')).toBeNull();
});
it("keeps old failure evidence neutral until a fresh post-merge result confirms failure or completion", async () => {
  await render(completionPr("failed", true)); await act(async () => trigger().click());
  expect(container.textContent).toContain("Current results have not been checked yet");
  expect(container.querySelector('[role="status"]')?.className).not.toContain("text-destructive");
  await render(completionPr("failed"));
  expect(container.textContent).toContain("Post-merge CI failed");
  expect(container.querySelector('[role="status"]')?.className).toContain("text-destructive");
  await render({ ...pr(), observation: { ...pr().observation!, state: "merged", complete: true, checks: [{ name: "PR build", state: "SUCCESS" }] } });
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
  expect(container.textContent).toContain("CI passed");
  expect(container.querySelector('[role="status"]')).toBeNull();
});
it.each(["unverified", "unavailable"])("shows %s evidence as unknown, not a CI failure", async state => {
  await render(completionPr(state)); await act(async () => trigger().click());
  expect(container.textContent).toContain("Could not confirm post-merge CI");
  expect(container.querySelector('[role="status"]')?.className).not.toContain("text-destructive");
});
