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
