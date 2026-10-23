// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceReview, type ReviewChoice } from "./workspace-review";
import { developmentRequest, type Worktree } from "@/lib/development-api";
import type { ReviewInventory, ReviewDiff } from "@/lib/workspace-review-api";
vi.mock("@/lib/development-api", async original => ({ ...await original<object>(), developmentRequest: vi.fn() }));
vi.mock("./workspace-diff-view", () => ({ default: ({ diff, onAsk, threads, onThreadAsk, onReply, onResolve }: { onReply?: unknown; onResolve?: unknown; diff: ReviewDiff["diff"]; threads: ReviewInventory["threads"]; onAsk?: (range: unknown) => void; onThreadAsk?: (thread: unknown) => void }) => <div data-preview={diff.path} data-can-reply={!!onReply} data-can-resolve={!!onResolve}>{diff.combined}<button onClick={() => onAsk?.({ start: 9, side: "deletions", end: 12, endSide: "additions" })}>Ask selected lines</button>{threads.map(thread => <button key={thread.id} onClick={() => onThreadAsk?.(thread)}>Ask thread {thread.id}</button>)}</div> }));
vi.mock("./markdown", () => ({ Markdown: ({ text }: { text: string }) => <p>{text}</p> }));
let root: Root, container: HTMLDivElement;
const prUrl = "https://github.com/example/repo/pull/5";
const tree = (): Worktree => ({ id: "tree", workspaceId: "workspace", repository: "https://example.test/repo.git", branch: "work", targetBranch: "main", state: "active", apps: [], leases: [], pullRequests: [{ url: prUrl, observation: { at: "2026-10-21T17:00:00Z", state: "open", draft: false, unresolvedThreads: 1, title: "Published fix" } }], observationRevision: "first",
  observation: { at: "2026-10-21T17:00:00Z", head: "local-head", state: "ok", local: { files: [], truncated: false } }, sessionChanges: [] });
const ask = vi.fn(), back = vi.fn();
const inventory = (revision = "review-first"): ReviewInventory => ({ source: { scope: "pull-request", label: "Published fix", base: "pr-base", mergeBase: "pr-merge-base", head: "published-head", pullRequestUrl: prUrl, observedAt: "2026-10-21T17:00:00Z", revision, published: true, localHead: "local-head", notPublished: true }, files: ["one.txt", "two.txt"].map(path => ({ path, status: "M", lineStats: { additions: 2, deletions: 1 } })), threads: [{ id: "thread-one", path: "one.txt", line: 12, diffSide: "RIGHT", resolved: false, comments: ["Review comment"], commentsComplete: true }], truncated: false, observation: { at: "2026-10-21T17:00:00Z", state: "open", draft: false, unresolvedThreads: 1, complete: false } });
const makeDiff = (value: ReviewInventory, path = "one.txt", combined = "Published patch"): ReviewDiff => ({ source: value.source, diff: { path, combined, head: "different-diff-base", binary: false, truncated: false, contentKind: "patch" }, localRanges: [], localRangesComplete: true });
function Harness({ value, initialChoice = { view: `pr:${prUrl}`, path: "" } }: { value: Worktree; initialChoice?: ReviewChoice }) {
  const [choice, setChoice] = useState<ReviewChoice>(initialChoice);
  return <WorkspaceReview workspaceId="workspace" tree={value} choice={choice} onChoice={setChoice} onAsk={ask} onBack={back} />;
}
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === text)!;
const pick = (path: string) => [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Changed files"] button')].find(node => node.title === path)!;
function replies(value: ReviewInventory) {
  vi.mocked(developmentRequest).mockImplementation(async path => path?.includes("/review/diff?") ? makeDiff(value, new URLSearchParams(path.split("?")[1]).get("path")!) as never : value as never);
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); ask.mockReset(); back.mockReset(); sessionStorage.clear();
  vi.mocked(developmentRequest).mockReset();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it("uses the published source and exact cross-side coordinates in a structured Ask reference without sending a message", async () => {
  replies(inventory()); await act(async () => root.render(<Harness value={tree()} />));
  await vi.waitFor(() => expect(container.querySelector('[data-preview]')).not.toBeNull());
  await act(async () => button("Ask selected lines").click());
  const reference = JSON.parse(ask.mock.calls[0][0].split("\n").slice(1).join("\n"));
  expect(reference).toMatchObject({ source: "pull-request", pullRequest: prUrl, file: "one.txt", start: { side: "deletions", line: 9 }, end: { side: "additions", line: 12 }, baseRevision: "pr-merge-base", headRevision: "published-head", revision: "review-first", published: true });
  expect(container.textContent).toContain("Published PR"); expect(container.textContent).toContain("Local changes not published");
  expect(container.querySelector('[data-preview]')?.getAttribute("data-can-reply")).toBe("true");
  expect(container.querySelector('[data-preview]')?.getAttribute("data-can-resolve")).toBe("true");
  await act(async () => button("Ask thread thread-one").click());
  expect(JSON.parse(ask.mock.calls[1][0].split("\n").slice(1).join("\n"))).toMatchObject({ threadId: "thread-one", headRevision: "published-head", pullRequest: prUrl });
  expect(vi.mocked(developmentRequest).mock.calls.every(([, body]) => body === undefined)).toBe(true);
});
it("aborts a superseded file response and invalidates viewed marks when the source revision changes", async () => {
  let resolveOld!: (value: ReviewDiff) => void; let current = inventory();
  const value = tree();
  vi.mocked(developmentRequest).mockImplementation(async path => {
    if (path?.endsWith("refresh=true")) { current = inventory("review-second"); return { ...value, observationRevision: "second" } as never; }
    if (path?.includes("/review/diff?")) {
      const selected = new URLSearchParams(path.split("?")[1]).get("path")!;
      if (selected === "one.txt" && !resolveOld) return await new Promise<ReviewDiff>(resolve => { resolveOld = resolve; }) as never;
      return makeDiff(current, selected, "latest") as never;
    }
    return current as never;
  });
  await act(async () => root.render(<Harness value={value} />));
  await act(async () => pick("two.txt").click()); await vi.waitFor(() => expect(container.textContent).toContain("latest"));
  await act(async () => resolveOld(makeDiff(inventory(), "one.txt", "stale"))); expect(container.textContent).not.toContain("stale");
  await act(async () => container.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click()); expect(container.textContent).toContain("1 of 2 viewed");
  await act(async () => button("Refresh files").click()); expect(container.textContent).toContain("0 of 2 viewed");
  expect(container.querySelector('[aria-current="true"]')?.textContent).toContain("two.txt");
});
it("keeps inventory errors explicit and retries only on request", async () => {
  vi.mocked(developmentRequest).mockRejectedValueOnce(new Error("Source access unavailable"));
  await act(async () => root.render(<Harness value={tree()} />)); expect(container.querySelector('[role="alert"]')?.textContent).toContain("Source access unavailable");
  replies(inventory()); await act(async () => button("Retry review").click()); await vi.waitFor(() => expect(container.textContent).toContain("Published patch"));
  await act(async () => container.querySelector('[aria-label="Workspace review"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))); expect(back).toHaveBeenCalledOnce();
});
it("retains comments for unchanged files without fabricating a diff and keeps actions when a real diff read fails", async () => {
  const value = inventory(); value.threads.push({ id: "unchanged-thread", path: "unchanged.txt", resolved: false, comments: ["Retained unchanged-file comment"], commentsComplete: false, outdated: true });
  vi.mocked(developmentRequest).mockImplementation(async path => { if (path?.includes("/review/diff?")) throw new Error("Could not load PR blob"); return value as never; });
  await act(async () => root.render(<Harness value={tree()} />));
  expect(container.textContent).toContain("Could not load PR blob"); expect(container.textContent).toContain("Review comment");
  const before = vi.mocked(developmentRequest).mock.calls.length;
  await act(async () => pick("unchanged.txt").click());
  expect(container.textContent).toContain("Comments only"); expect(container.textContent).toContain("Retained unchanged-file comment");
  expect(container.textContent).toContain("Some replies have not been loaded"); expect(vi.mocked(developmentRequest).mock.calls).toHaveLength(before);
});
it("refuses a diff from another source revision without marking it Viewed", async () => {
  const value = inventory(); vi.mocked(developmentRequest).mockImplementation(async path => path?.includes("/review/diff?") ? makeDiff(inventory("replaced-head")) as never : value as never);
  await act(async () => root.render(<Harness value={tree()} />));
  expect(container.textContent).toContain("The review source changed"); expect(container.querySelector('[data-preview]')).toBeNull();
  expect(container.querySelector<HTMLButtonElement>('[role="checkbox"]')?.disabled).toBe(true);
});

it("keeps a requested transcript path explicit when it is no longer changed instead of reading a different file", async () => {
  const value = inventory(); value.source = { ...value.source, scope: "session", published: false, pullRequestUrl: null }; value.threads = [];
  replies(value); await act(async () => root.render(<Harness value={tree()} initialChoice={{ view: "session", path: "no-longer-changed.ts" }} />));
  expect(container.textContent).toContain("no-longer-changed.ts"); expect(container.textContent).toContain("This file has no changes in this scope");
  expect(container.querySelector('[data-preview]')).toBeNull(); expect(vi.mocked(developmentRequest).mock.calls.some(([path]) => path?.includes("/review/diff?"))).toBe(false);
  expect(container.querySelector('[aria-label="Changed files"]')?.classList.contains("hidden")).toBe(true);
});

it("dismisses a scope picker with Escape while retaining the review and comment draft", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  replies(inventory()); await act(async () => root.render(<Harness value={tree()} />));
  await act(async () => button("New comment").click());
  const field = container.querySelector<HTMLTextAreaElement>('[aria-label="New PR comment"] textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Keep this review draft");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => container.querySelector('[aria-label="Diff scope"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  const picker = document.querySelector('[role="listbox"]'); expect(picker).not.toBeNull();
  await act(async () => picker!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(back).not.toHaveBeenCalled();
  expect(container.querySelector('[aria-label="Workspace review"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="New PR comment"] textarea')).toBe(field);
  expect(field.value).toBe("Keep this review draft");
  expect(vi.mocked(developmentRequest).mock.calls.every(([, body]) => body === undefined)).toBe(true);
});
