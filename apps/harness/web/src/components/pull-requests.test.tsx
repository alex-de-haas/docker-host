// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ request: vi.fn(), subscribe: vi.fn().mockReturnValue(() => {}), ui: { getNavigation: vi.fn(), navigate: vi.fn(), reportSurfaceState: vi.fn() } }));
vi.mock("@hosty-sdk/app/ui/react", () => ({ useHostyUi: () => mock.ui }));
vi.mock("@/lib/pull-requests-api", async original => ({ ...await original<object>(), prRequest: mock.request }));
vi.mock("@/lib/pull-requests-events", () => ({ subscribePullRequests: mock.subscribe }));
vi.mock("./workspace-diff-view", () => ({ default: () => <div>Diff preview</div> }));
import { PullRequests } from "./pull-requests";
let root: Root, container: HTMLDivElement;
const repositoryId = "a".repeat(64);
const receipt = { schemaVersion: 1, revision: "one", freshness: "fresh", completeness: "complete" };
const pr = { repositoryId, number: 12, title: "Update dependencies", author: "dependabot[bot]", bot: true, draft: false, state: "open", head: "a".repeat(40), base: "b".repeat(40), headBranch: "deps", baseBranch: "main", url: "https://github.com/example/repo/pull/12", checks: { items: [{ id: "build", name: "Build", state: "passed" }, { id: "tests", name: "Tests", state: "running" }, { id: "optional", name: "Optional", state: "skipped" }], total: 3, completeness: "complete" }, receipt };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear(); window.history.replaceState({}, "", "/pull-requests-panel");
  mock.ui.getNavigation.mockReturnValue({ entries: [{ key: "bound-key", route: "/pull-requests" }] });
  mock.ui.navigate.mockResolvedValue({ status: "accepted" });
  mock.request.mockReset().mockImplementation(async (path: string) => path === "/repositories" ? { storageScope: "owner-installation", repositories: [{ id: repositoryId, name: "example/repo", apps: [{ id: "fixture-app", name: "Fixture app" }] }], coverage: [], receipt }
    : path.endsWith("/actions") ? { head: pr.head, base: pr.base, merge: { enabled: false }, updateBranch: { enabled: false }, autoMerge: "disabled" }
    : path.startsWith("?") ? { items: [pr], loaded: 1, total: 1, receipt }
    : { pullRequest: pr, description: "Independent PR description\n\n<details><summary>Release notes</summary><p>Fixed rendering</p></details>", descriptionTruncated: false, links: [], receipt });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
const row = () => container.querySelector<HTMLButtonElement>('[role=listitem] button')!;
it("keeps the compact panel mounted and navigates through the bound main entry without creating a chat", async () => {
  await act(async () => root.render(<PullRequests compact />));
  expect(container.textContent).toContain("2/3 completed"); expect(container.textContent).toContain("1 skipped");
  expect(container.querySelector('[aria-label="Pull request details"]')).toBeNull();
  expect(row().textContent).toContain("dependabot[bot]"); expect(row().textContent).toContain("CI 2/3");
  expect(row().textContent).not.toContain("Fixture app"); expect(row().getAttribute("aria-expanded")).toBeNull();
  await act(async () => row().click());
  expect(mock.ui.navigate).toHaveBeenCalledWith("bound-key", expect.objectContaining({ placement: "main", search: `?repo=${repositoryId}&pr=12` }));
  expect(window.location.pathname).toBe("/pull-requests-panel");
  expect(mock.request.mock.calls.every(([path]) => !String(path).includes("sessions"))).toBe(true);
});
it("offers a separate-open link when main navigation is unavailable", async () => {
  mock.ui.getNavigation.mockReturnValue({ entries: [] });
  await act(async () => root.render(<PullRequests compact />)); await act(async () => row().click());
  expect(container.querySelector<HTMLAnchorElement>('a[target="_blank"]')?.getAttribute("href")).toBe(`/pull-requests?repo=${repositoryId}&pr=12`);
  expect(window.location.pathname).toBe("/pull-requests-panel");
});
it("renders an external PR description without workspace, routine or decision capability", async () => {
  window.history.replaceState({}, "", `/pull-requests?repo=${repositoryId}&pr=12`);
  await act(async () => root.render(<PullRequests />));
  expect(container.textContent).toContain("Independent PR description");
  expect(container.querySelector('[aria-label="Pull request details"] details summary')?.textContent).toBe("Release notes");
  expect(container.textContent).not.toContain("<summary>");
  expect(container.textContent).not.toMatch(/Start analysis|Approve merge/);
  expect(container.textContent).toContain("Auto-merge: disabled");
  expect(container.querySelector('a[href^="/development"]')).toBeNull();
});

it("retains an exact-head diff through unrelated background observations", async () => {
  window.history.replaceState({}, "", `/pull-requests?repo=${repositoryId}&pr=12`);
  const original = mock.request.getMockImplementation()!;
  mock.request.mockImplementation(async (path: string, ...args: unknown[]) => path.includes("/diff?")
    ? { head: pr.head, base: pr.base, mergeBase: pr.base, files: [{ path: "package.json", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" }], receipt } : original(path, ...args));
  await act(async () => root.render(<PullRequests />));
  const changes = [...container.querySelectorAll("button")].find(b => b.textContent === "changes")!;
  await act(async () => changes.click());
  const count = () => mock.request.mock.calls.filter(([path]) => String(path).includes("/diff?")).length;
  expect(count()).toBe(1);
  const subscriber = mock.subscribe.mock.calls.at(-1)![1] as { sync: () => Promise<void> };
  await act(async () => subscriber.sync());
  expect(count()).toBe(1);
});
