// @vitest-environment jsdom
import { act, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppMentionInput } from "./app-mention-input";
import { AssistantApiError, getSession, listContextApps, setSessionApps, type AssistantSession } from "@/lib/assistant-api";
import { readMentionDraft } from "@/lib/app-mentions";
vi.mock("@/lib/assistant-api", async original => ({ ...await original<typeof import("@/lib/assistant-api")>(), listContextApps: vi.fn(), setSessionApps: vi.fn(), getSession: vi.fn() }));
const app = { id: "media", displayName: "Media Server", available: true };
let root: Root, container: HTMLDivElement;
let record: AssistantSession;
const sent = vi.fn(), busy = vi.fn(), changed = vi.fn();
function Harness({ seed = "", id = "s" }: { seed?: string; id?: string }) {
  const [text, setText] = useState(seed);
  const [session, setSession] = useState({ ...record, id });
  return <AppMentionInput session={session} value={text} onChange={setText} inputRef={useRef(null)} contextBusy={false} aria-label="Message"
    onContextChange={value => { setSession(value); changed(value); }} onBusyChange={busy} onKeyDown={event => { if (event.key === "Enter") sent(text); }} />;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
  localStorage.clear();
  record = { id: "s", title: null, status: "idle", createdAt: "", appIds: [], appContextRevision: 2 };
  vi.mocked(listContextApps).mockResolvedValue({ apps: [app], nextOffset: null });
  vi.mocked(setSessionApps).mockImplementation(async (_id, appIds) => ({ ...record, appIds, appContextRevision: 3 }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
const input = () => container.querySelector<HTMLTextAreaElement>("textarea")!;
const render = (seed = "") => act(async () => root.render(<Harness seed={seed} />));
const type = (text: string) => act(async () => {
  input().focus();
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input(), text);
  input().setSelectionRange(text.length, text.length);
  input().dispatchEvent(new Event("input", { bubbles: true }));
});
const load = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 180)); });
const key = (key: string, other = {}) => act(async () => { input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...other })); });

it("selects on Enter, waits for association, preserves stable text and leaves context on text deletion", async () => {
  let resolve!: (value: AssistantSession) => void;
  vi.mocked(setSessionApps).mockReturnValue(new Promise(done => { resolve = done; }));
  await render(); await type("Check @media"); await load(); await key("Enter");
  expect(sent).not.toHaveBeenCalled();
  expect(setSessionApps).toHaveBeenCalledExactlyOnceWith("s", ["media"], 2);
  expect(input().value).toBe("Check @media"); expect(input().readOnly).toBe(true);
  expect(busy).toHaveBeenLastCalledWith(true);
  await act(async () => resolve({ ...record, appIds: ["media"], appContextRevision: 3 }));
  expect(input().value).toBe("Check @Media Server ");
  expect(container.querySelector("mark")?.textContent).toBe("@Media Server");
  expect(readMentionDraft("s", input().value).mentions).toHaveLength(1);
  expect(busy).toHaveBeenLastCalledWith(false);
  await type("");
  expect(setSessionApps).toHaveBeenCalledTimes(1);
  await key("z", { ctrlKey: true });
  expect(container.querySelector("mark")).not.toBeNull();
  await key("z", { ctrlKey: true, shiftKey: true }); expect(input().value).toBe("");
});
it("reuses selected apps, supports Escape and submits only after the suggestion closes", async () => {
  record.appIds = ["media"];
  await render(); await type("@media"); await load(); await key("Enter");
  expect(setSessionApps).not.toHaveBeenCalled();
  await key("Enter"); expect(sent).toHaveBeenLastCalledWith("@Media Server ");
  await type("@unknown"); await key("Escape"); await key("Enter");
  expect(sent).toHaveBeenLastCalledWith("@unknown");
});
it("enforces 16 apps while still permitting a mention of an already selected app", async () => {
  record.appIds = Array.from({ length: 16 }, (_, i) => `app-${i}`);
  await render(); await type("@media"); await load(); await key("Enter");
  expect(setSessionApps).not.toHaveBeenCalled(); expect(input().value).toBe("@media");
  expect(document.body.textContent).toContain("16-app limit reached");
});
it("retains text and reloads authoritative context on a revision conflict", async () => {
  vi.mocked(setSessionApps).mockRejectedValue(new AssistantApiError("app_context_conflict", "Context changed"));
  vi.mocked(getSession).mockResolvedValue({ ...record, appIds: ["other"], appContextRevision: 5 });
  await render(); await type("@media"); await load(); await key("Enter");
  expect(input().value).toBe("@media"); expect(container.querySelector("mark")).toBeNull();
  expect(changed).toHaveBeenCalledWith(expect.objectContaining({ appContextRevision: 5 }));
  expect(document.body.textContent).toContain("Context changed");
});
it("ignores a completed save after switching sessions", async () => {
  let resolve!: (value: AssistantSession) => void;
  vi.mocked(setSessionApps).mockReturnValue(new Promise(done => { resolve = done; }));
  await render(); await type("@media"); await load(); await key("Enter");
  await act(async () => root.render(<Harness key="other" id="other" seed="Keep this draft" />));
  await act(async () => resolve({ ...record, appIds: ["media"] }));
  expect(input().value).toBe("Keep this draft"); expect(changed).not.toHaveBeenCalled();
  expect(busy).toHaveBeenLastCalledWith(false);
});
it("does not use stale search responses and does not send while composing", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof listContextApps>>) => void;
  vi.mocked(listContextApps).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  await render(); await type("@old"); await load(); await type("@media"); await load();
  await act(async () => resolve({ apps: [{ ...app, id: "old", displayName: "Old" }], nextOffset: null }));
  expect(document.querySelector('[role="option"]')?.textContent).toContain("Media Server");
  await key("Enter", { isComposing: true }); expect(sent).not.toHaveBeenCalled(); expect(setSessionApps).not.toHaveBeenCalled();
});
it("restores highlights on remount without creating associations", async () => {
  await render(); await type("@media"); await load(); await key("Enter");
  const text = input().value;
  await act(async () => root.render(null));
  record.appIds = ["media"];
  await render(text);
  expect(container.querySelector("mark")?.textContent).toBe("@Media Server");
  expect(setSessionApps).toHaveBeenCalledTimes(1);
});

it("retains query text on network failure and retries the selected app", async () => {
  vi.mocked(setSessionApps).mockRejectedValueOnce(new Error("Connection lost"));
  await render(); await type("@media"); await load(); await key("Enter");
  expect(input().value).toBe("@media"); expect(document.body.textContent).toContain("Connection lost");
  await key("Enter"); expect(input().value).toBe("@Media Server ");
});
it("supports native undo/redo commands with mention identity", async () => {
  await render(); await type("@media"); await load(); await key("Enter");
  await act(async () => input().dispatchEvent(new InputEvent("beforeinput", { inputType: "historyUndo", bubbles: true, cancelable: true })));
  expect(input().value).toBe("@media"); expect(container.querySelector("mark")).toBeNull();
  await act(async () => input().dispatchEvent(new InputEvent("beforeinput", { inputType: "historyRedo", bubbles: true, cancelable: true })));
  expect(container.querySelector("mark")).not.toBeNull();
});
it("does not overwrite external draft edits during an association save", async () => {
  let resolve!: (value: AssistantSession) => void;
  vi.mocked(setSessionApps).mockReturnValue(new Promise(done => { resolve = done; }));
  // An external insertion (such as completed dictation) can update a disabled text field's state.
  let edit!: (text: string) => void;
  function External() {
    const [text, setText] = useState(""); useEffect(() => { edit = setText; }, []);
    return <AppMentionInput session={record} value={text} onChange={setText} inputRef={useRef(null)} contextBusy={false} aria-label="Message" onContextChange={changed} onBusyChange={busy} />;
  }
  await act(async () => root.render(<External />)); await type("@media"); await load(); await key("Enter");
  await act(async () => edit("@media dictated text"));
  await act(async () => resolve({ ...record, appIds: ["media"], appContextRevision: 3 }));
  expect(input().value).toBe("@media dictated text"); expect(changed).toHaveBeenCalled(); expect(container.querySelector("mark")).toBeNull();
});
it("copies and cuts compact mentions as stable-id text without removing context", async () => {
  await render(); await type("@media"); await load(); await key("Enter");
  expect(input().value).toBe("@Media Server ");
  input().setSelectionRange(0, input().value.length);
  const setData = vi.fn();
  const dispatch = async (type: string) => act(async () => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { setData } });
    input().dispatchEvent(event);
  });
  await dispatch("copy"); expect(setData).toHaveBeenLastCalledWith("text/plain", "@Media Server (media) ");
  await dispatch("cut"); expect(input().value).toBe(""); expect(setSessionApps).toHaveBeenCalledTimes(1);
  await key("z", { metaKey: true }); expect(container.querySelector("mark")?.textContent).toBe("@Media Server");
});
