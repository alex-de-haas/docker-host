// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AssistantPage from "./page";
import * as api from "@/lib/assistant-api";

vi.mock("@/lib/api", () => ({ establishSession: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/assistant-api", async original => ({
  ...await original<typeof api>(),
  getHealth: vi.fn(), listSessions: vi.fn(), getSession: vi.fn(), createSession: vi.fn(),
  listAppNames: vi.fn(), postMessage: vi.fn(), stopSession: vi.fn(), streamEvents: vi.fn(),
}));
vi.mock("@/components/app-context-picker", () => ({ AppContextPicker: () => null }));
vi.mock("@/components/ui/message-scroller", () => {
  const Wrap = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return { ...Object.fromEntries(["MessageScroller", "MessageScrollerProvider", "MessageScrollerViewport", "MessageScrollerContent", "MessageScrollerItem"].map(name => [name, Wrap])), MessageScrollerButton: () => null };
});

let root: Root;
let container: HTMLDivElement;
let record: api.AssistantSession;
let emit: (event: api.AssistantEvent) => void;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  record = { id: "session-one", title: "Conversation", status: "idle", createdAt: "" };
  vi.mocked(api.getHealth).mockResolvedValue({ name: "fake", available: true });
  vi.mocked(api.listSessions).mockResolvedValue([record]);
  vi.mocked(api.getSession).mockImplementation(async () => ({ ...record }));
  vi.mocked(api.createSession).mockResolvedValue(record);
  vi.mocked(api.listAppNames).mockResolvedValue({});
  vi.mocked(api.streamEvents).mockImplementation(async (_id, listener) => { emit = listener; });
  vi.mocked(api.postMessage).mockResolvedValue(undefined);
  vi.mocked(api.stopSession).mockResolvedValue(undefined);
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove(); vi.resetAllMocks(); vi.unstubAllGlobals();
});
const render = () => act(async () => root.render(<AssistantPage />));
const button = (name: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
const input = () => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
const type = (text: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input(), text);
  input().dispatchEvent(new Event("input", { bubbles: true }));
});
const status = (value: string) => act(async () => {
  record.status = value;
  emit({ type: "session_status", status: value, seq: 1, ts: "" });
});
const submit = () => act(async () => {
  input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
});

it.each(["running", "awaiting_approval", "awaiting_question"])("keeps a draft unsent and shows only composer Stop while %s", async value => {
  record.status = value;
  await render();
  await type("Next message");
  expect(input().disabled).toBe(false);
  expect(button("Send")).toBeNull();
  expect(container.querySelectorAll('button[aria-label="Stop"]')).toHaveLength(1);
  expect(button("Stop")?.closest("form")).not.toBeNull();
  await submit();
  expect(api.postMessage).not.toHaveBeenCalled();
  expect(api.stopSession).not.toHaveBeenCalled();
  await act(async () => button("Stop")!.click());
  expect(api.stopSession).toHaveBeenCalledExactlyOnceWith(record.id);
  await status("cancelled");
  expect(input().value).toBe("Next message");
  expect(button("Stop")).toBeNull();
  expect(button("Send")?.disabled).toBe(false);
  // Completion never automatically sends the draft.
  expect(api.postMessage).not.toHaveBeenCalled();
  await act(async () => button("Send")!.click());
  expect(api.postMessage).toHaveBeenCalledExactlyOnceWith(record.id, "Next message", [], 0, false);
});

it("locks immediately after sending, including before SSE, and unlocks on completion", async () => {
  await render();
  expect(button("Stop")).toBeNull();
  await type("First message");
  await submit();
  expect(api.postMessage).toHaveBeenCalledTimes(1);
  expect(button("Stop")?.disabled).toBe(false);
  await type("Draft for later");
  await submit();
  expect(api.postMessage).toHaveBeenCalledTimes(1);
  await status("idle");
  expect(button("Send")?.disabled).toBe(false);
  expect(input().value).toBe("Draft for later");
});

it("preserves the draft after a failed stop and permits retry", async () => {
  record.status = "running";
  vi.mocked(api.stopSession).mockRejectedValueOnce(new Error("Connection lost"));
  await render(); await type("Keep this draft");
  await act(async () => button("Stop")!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Connection lost");
  expect(input().value).toBe("Keep this draft");
  expect(button("Stop")?.disabled).toBe(false);
  await act(async () => button("Stop")!.click());
  expect(api.stopSession).toHaveBeenCalledTimes(2);
});

it("restores Send and the draft when posting fails", async () => {
  vi.mocked(api.postMessage).mockRejectedValueOnce(new Error("Send failed"));
  await render(); await type("Try again");
  await act(async () => button("Send")!.click());
  expect(button("Send")?.disabled).toBe(false);
  expect(button("Stop")).toBeNull();
  expect(input().value).toBe("Try again");
});

it("accepts a fast completion before the send response without getting stuck on Stop", async () => {
  vi.mocked(api.postMessage).mockImplementation(async () => {
    emit({ type: "session_status", status: "idle", seq: 2, ts: "" });
  });
  await render(); await type("Quick request");
  await act(async () => button("Send")!.click());
  expect(button("Stop")).toBeNull();
  expect(button("Send")).not.toBeNull();
});

it("keeps Stop pending through a status change and prevents duplicate requests", async () => {
  record.status = "running";
  let finish!: () => void;
  vi.mocked(api.stopSession).mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  await render(); await type("Draft");
  await act(async () => { button("Stop")!.click(); button("Stop")!.click(); });
  expect(api.stopSession).toHaveBeenCalledTimes(1);
  expect(button("Stop")?.disabled).toBe(true);
  await status("cancelled");
  await submit();
  expect(api.postMessage).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(button("Send")?.disabled).toBe(false);
  expect(input().value).toBe("Draft");
});

it("opens an error in a fresh session draft without sending or replacing the old draft", async () => {
  await render();
  await type("My existing draft");
  const fresh = { ...record, id: "error-session", appIds: ["demo.app"] };
  vi.mocked(api.getSession).mockResolvedValue(fresh);
  const handoff = () => act(async () => {
    window.dispatchEvent(new MessageEvent("message", { source: window.parent, data: {
      type: "hosty:open-assistant-session", sessionId: fresh.id, draft: "Port 8080 is in use", sourceAppId: "demo.app",
    } }));
  });
  await handoff();
  expect(input().value).toBe("From demo.app: Port 8080 is in use");
  expect(api.postMessage).not.toHaveBeenCalled();
  await type("Edited error draft");
  await handoff();
  expect(input().value).toBe("Edited error draft");
  vi.mocked(api.getSession).mockResolvedValue(record);
  await act(async () => window.dispatchEvent(new MessageEvent("message", { source: window.parent, data: { type: "hosty:open-assistant-session", sessionId: record.id } })));
  expect(input().value).toBe("My existing draft");
  expect(api.postMessage).not.toHaveBeenCalled();
});

it("does not accept an error-session handoff from another frame", async () => {
  await render(); await type("Keep this");
  vi.mocked(api.getSession).mockClear();
  await act(async () => window.dispatchEvent(new MessageEvent("message", { source: null, data: {
    type: "hosty:open-assistant-session", sessionId: "untrusted", draft: "Injected text",
  } })));
  expect(api.getSession).not.toHaveBeenCalled();
  expect(input().value).toBe("Keep this");
  expect(api.postMessage).not.toHaveBeenCalled();
});
