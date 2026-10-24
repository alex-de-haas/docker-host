// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReviewCommentComposer } from "./review-comment-composer";
import { ReviewThreadActionError } from "./review-thread";
let root: Root, container: HTMLDivElement;
const originalLocation = { path: "src/example.ts", diffSide: "RIGHT" as const, startLine: 8, line: 10 };
const base = () => ({ storageScope: "user-one:workspace:tree:pr-one", head: "original-published-head", location: originalLocation, prNumber: "7", pullRequestUrl: "https://github.com/example/repo/pull/7", canStart: true,
  onSubmit: vi.fn().mockResolvedValue({ threadId: "thread", commentId: "comment" }), onAsk: vi.fn(), onClose: vi.fn(), onPosted: vi.fn() });
type Props = ComponentProps<typeof ReviewCommentComposer>;
const render = (props: Props) => act(async () => root.render(<ReviewCommentComposer {...props} />));
const button = (text: string) => [...container.querySelectorAll("button")].find(node => node.textContent === text)!;
async function type(value: string) { await act(async () => { const field = container.querySelector("textarea")!; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); }); }
const click = (node: HTMLElement) => act(async () => node.click());
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); sessionStorage.clear(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("adds an Ask reference only after a confirmed post, with the PR, published head and selected range", async () => {
  const props = base(); let confirm: ((value: { threadId: string; commentId: string }) => void) | undefined;
  props.onSubmit.mockImplementation(() => new Promise(resolve => { confirm = resolve; }));
  await render(props); await type("  Please adjust the range  "); await click(container.querySelector('[role="checkbox"]')!);
  await click(button("Post comment"));
  expect(props.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ head: props.head, location: originalLocation, body: "Please adjust the range", ask: true, requestId: expect.any(String) }), false);
  expect(props.onAsk).not.toHaveBeenCalled(); expect(props.onPosted).not.toHaveBeenCalled();
  expect(container.querySelector("textarea")?.readOnly).toBe(true); expect(button("Posting…").disabled).toBe(true);
  await act(async () => confirm!({ threadId: "posted-thread", commentId: "posted-comment" }));
  expect(props.onAsk).toHaveBeenCalledOnce(); const reference = JSON.parse(props.onAsk.mock.calls[0][0].split("\n").slice(1).join("\n"));
  expect(reference).toMatchObject({ pullRequest: props.pullRequestUrl, threadId: "posted-thread", commentId: "posted-comment", file: originalLocation.path, startLine: 8, line: 10, side: "RIGHT", headRevision: props.head, comment: "Please adjust the range" });
  expect(props.onPosted).toHaveBeenCalledOnce(); expect(props.onClose).toHaveBeenCalledExactlyOnceWith("posted"); expect(container.querySelector("textarea")?.value).toBe("");
});
it("recovers the same UUID, original head, body, range and Ask intent across remount after the head moves and PR closes", async () => {
  const props = base(); props.onSubmit.mockRejectedValueOnce(new Error("Response lost")).mockResolvedValueOnce({ threadId: "thread", commentId: "comment" });
  await render(props); await type("Original comment"); await click(container.querySelector('[role="checkbox"]')!); await click(button("Post comment"));
  const first = props.onSubmit.mock.calls[0][0]; expect(props.onAsk).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Recovery keeps the same request and original head");
  await act(async () => root.render(null)); await render({ ...props, head: "new-head", location: { path: "other.ts", diffSide: "LEFT", startLine: 20, line: 21 }, canStart: false });
  expect(container.textContent).toContain("src/example.ts · new lines 8–10"); expect(container.querySelector("textarea")?.value).toBe("Original comment");
  expect(container.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("true"); expect(button("Recover comment").disabled).toBe(false);
  await click(button("Recover comment")); expect(props.onSubmit.mock.calls[1][0]).toEqual(first); expect(props.onSubmit.mock.calls[0][1]).toBe(false); expect(props.onSubmit.mock.calls[1][1]).toBe(true); expect(props.onAsk).toHaveBeenCalledOnce();
});
it("retains a definitely rejected draft and permits a corrected comment with a fresh UUID", async () => {
  const props = base(); props.onSubmit.mockRejectedValueOnce(new ReviewThreadActionError("Head changed", true)).mockResolvedValueOnce({ threadId: "fixed", commentId: "fixed-comment" });
  await render(props); await type("Retain my draft"); await click(button("Post comment"));
  expect(container.textContent).toContain("Comment was not posted"); expect(container.querySelector("textarea")?.value).toBe("Retain my draft"); expect(container.querySelector("textarea")?.readOnly).toBe(false); expect(props.onAsk).not.toHaveBeenCalled();
  await type("Corrected comment"); await click(button("Post comment"));
  expect(props.onSubmit.mock.calls[1][0].body).toBe("Corrected comment"); expect(props.onSubmit.mock.calls[1][0].requestId).not.toBe(props.onSubmit.mock.calls[0][0].requestId);
});
it("isolates unsent drafts, Ask intent and pending recovery by operator and PR storage scope", async () => {
  const props = base(); props.onSubmit.mockRejectedValue(new Error("Unknown"));
  await render(props); await type("User one's pending comment"); await click(container.querySelector('[role="checkbox"]')!); await click(button("Post comment"));
  const first = props.onSubmit.mock.calls[0][0];
  await render({ ...props, storageScope: "user-two:workspace:tree:pr-one" });
  expect(container.querySelector("textarea")?.value).toBe(""); expect(button("Post comment").disabled).toBe(true);
  await render({ ...props, storageScope: "user-one:workspace:tree:pr-two" }); expect(container.querySelector("textarea")?.value).toBe("");
  await render(props); expect(container.querySelector("textarea")?.value).toBe("User one's pending comment");
  await click(button("Recover comment")); expect(props.onSubmit.mock.calls[1][0]).toEqual(first);
});
it("disables fresh posting without complete PR authority or a selected range and preserves a closed unsent draft", async () => {
  const props = base(); await render(props); await type("Draft without sending"); await click(button("Close comment"));
  expect(props.onClose).toHaveBeenCalledExactlyOnceWith("dismiss"); expect(props.onSubmit).not.toHaveBeenCalled();
  await act(async () => root.render(null)); await render({ ...props, canStart: false });
  expect(container.querySelector("textarea")?.value).toBe("Draft without sending"); expect(button("Post comment").disabled).toBe(true);
  await render({ ...props, location: null }); expect(button("Post comment").disabled).toBe(true); expect(props.onSubmit).not.toHaveBeenCalled();
  await render({ ...props, onAsk: undefined }); expect(container.querySelector<HTMLButtonElement>('[role="checkbox"]')?.disabled).toBe(true);
});
it("does not dispatch if a durable original request cannot be saved", async () => {
  const props = base(); await render(props); await type("Keep this draft");
  const save = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage full"); });
  await click(button("Post comment")); expect(props.onSubmit).not.toHaveBeenCalled(); expect(props.onAsk).not.toHaveBeenCalled();
  expect(container.querySelector("textarea")?.value).toBe("Keep this draft"); expect(container.textContent).toContain("Storage full"); save.mockRestore();
});

it("clears confirmed durable intent after unmount without invoking stale Ask, refresh or close callbacks", async () => {
  const props = base(); let confirm!: (value: { threadId: string; commentId: string }) => void;
  props.onSubmit.mockImplementation(() => new Promise(resolve => { confirm = resolve; }));
  await render(props); await type("Original pending comment"); await click(container.querySelector('[role="checkbox"]')!); await click(button("Post comment"));
  await act(async () => root.render(null)); await act(async () => confirm({ threadId: "thread", commentId: "comment" }));
  expect(props.onAsk).not.toHaveBeenCalled(); expect(props.onPosted).not.toHaveBeenCalled(); expect(props.onClose).not.toHaveBeenCalled();
  expect(JSON.parse(sessionStorage.getItem(`hosty.review-comment.${props.storageScope}`)!)).toEqual({ body: "", ask: false });
});
it("does not let a delayed old PR confirmation close, refresh or overwrite another PR's composer", async () => {
  const first = base(); let confirm!: (value: { threadId: string; commentId: string }) => void;
  first.onSubmit.mockImplementation(() => new Promise(resolve => { confirm = resolve; }));
  await render(first); await type("PR one comment"); await click(container.querySelector('[role="checkbox"]')!); await click(button("Post comment"));
  const second = { ...base(), storageScope: "user-one:workspace:tree:pr-two", prNumber: "8" }; await render(second); await type("PR two draft");
  const field = container.querySelector("textarea")!; field.focus();
  await act(async () => confirm({ threadId: "first-thread", commentId: "first-comment" }));
  expect(container.querySelector("textarea")).toBe(field); expect(field.value).toBe("PR two draft"); expect(document.activeElement).toBe(field);
  for (const props of [first, second]) { expect(props.onAsk).not.toHaveBeenCalled(); expect(props.onPosted).not.toHaveBeenCalled(); expect(props.onClose).not.toHaveBeenCalled(); }
  expect(JSON.parse(sessionStorage.getItem(`hosty.review-comment.${second.storageScope}`)!)).toMatchObject({ body: "PR two draft" });
});
it("retains a rejected old scope's draft without displaying its late error in the new PR composer", async () => {
  const first = base(); let reject!: (error: Error) => void;
  first.onSubmit.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  await render(first); await type("Rejected original draft"); await click(button("Post comment"));
  const second = { ...base(), storageScope: "user-one:workspace:tree:pr-two" }; await render(second); await type("New PR draft");
  await act(async () => reject(new ReviewThreadActionError("Old PR changed", true)));
  expect(container.querySelector("[role=alert]")).toBeNull(); expect(container.querySelector("textarea")?.value).toBe("New PR draft");
  await render(first); expect(container.querySelector("textarea")?.value).toBe("Rejected original draft"); expect(container.querySelector("textarea")?.readOnly).toBe(false); expect(button("Post comment")).toBeDefined();
});
it("focuses an explicit open request once and does not steal focus on ordinary data refresh/remount", async () => {
  const props = base(), handled = vi.fn(); await render({ ...props, focusRequest: "open-request", onFocusHandled: handled });
  expect(document.activeElement).toBe(container.querySelector("textarea")); expect(handled).toHaveBeenCalledOnce();
  button("Close comment").focus(); await render({ ...props, head: "refreshed-head", focusRequest: "open-request", onFocusHandled: handled });
  expect(document.activeElement).toBe(button("Close comment")); expect(handled).toHaveBeenCalledOnce();
  await act(async () => root.render(null)); await render({ ...props, focusRequest: null, onFocusHandled: handled });
  expect(document.activeElement).not.toBe(container.querySelector("textarea")); expect(handled).toHaveBeenCalledOnce();
});
