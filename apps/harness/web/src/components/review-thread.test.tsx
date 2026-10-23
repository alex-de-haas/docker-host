// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReviewThreadActionError, ReviewThreadCard } from "./review-thread";
import type { ReviewThread } from "@/lib/review-threads";
vi.mock("@/components/markdown", () => ({ Markdown: ({ text }: { text: string }) => <p>{text}</p> }));
let root: Root, container: HTMLDivElement;
const thread: ReviewThread = { id: "thread", path: "example.ts", line: 12, startLine: 10, diffSide: "RIGHT", resolved: false, changedLocally: true, comments: ["First", "Second"], commentsComplete: false,
  details: [{ id: "c1", body: "First", authorLogin: "review-bot", authorKind: "Bot", createdAt: "2026-10-21T12:00:00Z", url: "https://github.com/owner/repo/pull/1#discussion_r1" }, { id: "c2", body: "Second", authorLogin: "alice", authorKind: "User" }] };
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); sessionStorage.clear(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); sessionStorage.clear(); vi.unstubAllGlobals(); });
const button = (text: string) => [...container.querySelectorAll("button")].find(b => b.textContent === text)!;
async function typeReply(value: string) {
  const textarea = container.querySelector("textarea")!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
}
it("retains author, replies, pagination and independent unresolved/changed-locally state", async () => {
  const ask = vi.fn();
  await act(async () => root.render(<ReviewThreadCard thread={thread} onThreadAsk={ask} />));
  expect(container.textContent).toContain("Unresolved"); expect(container.textContent).toContain("Changed locally");
  expect(container.textContent).not.toContain("fixed"); expect(container.textContent).toContain("Bot"); expect(container.textContent).toContain("Reviewer");
  expect(container.querySelector("time")?.dateTime).toBe("2026-10-21T12:00:00.000Z");
  expect(container.querySelectorAll("a")).toHaveLength(1); expect(container.querySelector("a")?.rel).toBe("noopener noreferrer");
  expect(container.textContent).toContain("Some replies have not been loaded"); expect(button("Reply").disabled).toBe(true); expect(button("Resolve").disabled).toBe(true);
  await act(async () => button("Ask Harness").click()); expect(ask).toHaveBeenCalledWith(thread);
});
it("retains unsent drafts and reuses an uncertain reply body and UUID across remount and retry", async () => {
  const reply = vi.fn().mockRejectedValueOnce(new Error("Connection lost")).mockResolvedValueOnce(undefined);
  await act(async () => root.render(<ReviewThreadCard thread={thread} onReply={reply} />));
  await act(async () => button("Reply").click()); await typeReply("Keep this draft");
  await act(async () => button("Close reply").click()); await act(async () => button("Reply").click());
  expect(container.querySelector("textarea")?.value).toBe("Keep this draft");
  await act(async () => button("Post reply").click());
  expect(reply).toHaveBeenCalledWith(thread, "Keep this draft", expect.any(String));
  const requestId = reply.mock.calls[0][2];
  expect(container.querySelector("textarea")?.readOnly).toBe(true);
  await act(async () => root.render(null)); await act(async () => root.render(<ReviewThreadCard thread={thread} onReply={reply} />));
  await act(async () => button("Retry reply").click());
  expect(reply.mock.calls[1]).toEqual([thread, "Keep this draft", requestId]);
  expect(container.querySelector("textarea")).toBeNull(); expect(sessionStorage.getItem("hosty.review-thread.thread")).toBeNull();
});
it("allows a corrected new reply only after a definitive rejection, retaining the draft", async () => {
  const reply = vi.fn().mockRejectedValueOnce(new ReviewThreadActionError("The PR head changed", true)).mockResolvedValue(undefined);
  await act(async () => root.render(<ReviewThreadCard thread={thread} onReply={reply} />));
  await act(async () => button("Reply").click()); await typeReply("Retained after rejection"); await act(async () => button("Post reply").click());
  expect(container.querySelector("textarea")?.value).toBe("Retained after rejection"); expect(container.querySelector("textarea")?.readOnly).toBe(false);
  await typeReply("Corrected reply"); await act(async () => button("Post reply").click());
  expect(reply.mock.calls[1][1]).toBe("Corrected reply"); expect(reply.mock.calls[1][2]).not.toBe(reply.mock.calls[0][2]);
});
it("retries uncertain resolution with one request and does not resolve from overlap evidence", async () => {
  const resolve = vi.fn().mockRejectedValueOnce(new Error("Timed out")).mockResolvedValue(undefined);
  await act(async () => root.render(<ReviewThreadCard thread={thread} onResolve={resolve} />));
  await act(async () => button("Resolve").click());
  expect(container.textContent).toContain("Unresolved"); expect(container.textContent).toContain("Retry keeps the same request");
  await act(async () => button("Retry resolve").click()); expect(resolve.mock.calls[1]).toEqual(resolve.mock.calls[0]);
  await act(async () => root.render(<ReviewThreadCard thread={{ ...thread, resolved: true }} onResolve={resolve} />));
  expect(button("Resolve")).toBeUndefined(); expect(container.textContent).toContain("Changed locally");
});
it("renders legacy comment bodies honestly and rejects unsafe comment links", async () => {
  await act(async () => root.render(<ReviewThreadCard thread={{ ...thread, details: [{ id: "bad", body: "Comment", url: "javascript:alert(1)" }] }} />));
  expect(container.querySelector("a")).toBeNull(); expect(container.textContent).toContain("Author unavailable");
  await act(async () => root.render(<ReviewThreadCard thread={{ ...thread, details: undefined }} />));
  expect(container.textContent).toContain("First"); expect(container.textContent).toContain("Second");
});

it("recovers original pending operations after a PR closes or a fresh observation resolves the thread", async () => {
  const reply = vi.fn().mockRejectedValueOnce(new Error("Unknown reply result")).mockResolvedValue(undefined);
  const resolve = vi.fn().mockRejectedValueOnce(new Error("Unknown resolve result")).mockResolvedValue(undefined);
  const render = (value: ReviewThread, canStartThreadActions: boolean) => act(async () => root.render(<ReviewThreadCard thread={value} onReply={reply} onResolve={resolve} canStartThreadActions={canStartThreadActions} />));
  await render(thread, true); await act(async () => button("Reply").click()); await typeReply("Original pending reply"); await act(async () => button("Post reply").click());
  await act(async () => button("Resolve").click());
  const replyId = reply.mock.calls[0][2], resolveId = resolve.mock.calls[0][1];
  await render({ ...thread, resolved: true }, false);
  expect(button("Retry resolve").disabled).toBe(false); expect(button("Retry reply").disabled).toBe(false);
  await act(async () => button("Retry reply").click()); await act(async () => button("Retry resolve").click());
  expect(reply.mock.calls[1]).toEqual([expect.objectContaining({ resolved: true }), "Original pending reply", replyId]);
  expect(resolve.mock.calls[1]).toEqual([expect.objectContaining({ resolved: true }), resolveId]);
  expect(button("Reply").disabled).toBe(true); expect(button("Resolve")).toBeUndefined();
});
it("isolates drafts and recovery identifiers by workspace and PR context", async () => {
  const reply = vi.fn();
  await act(async () => root.render(<ReviewThreadCard thread={thread} onReply={reply} threadStorageScope="workspace-one:pr" />));
  await act(async () => button("Reply").click()); await typeReply("Workspace one draft");
  await act(async () => root.render(<ReviewThreadCard thread={thread} onReply={reply} threadStorageScope="workspace-two:pr" />));
  await act(async () => button("Reply").click()); expect(container.querySelector("textarea")?.value).toBe("");
  await act(async () => root.render(<ReviewThreadCard thread={thread} onReply={reply} threadStorageScope="workspace-one:pr" />));
  expect(container.querySelector("textarea")?.value).toBe("Workspace one draft");
});
