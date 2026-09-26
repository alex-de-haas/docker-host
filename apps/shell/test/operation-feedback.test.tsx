import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useConfirmation } from "../src/components/reui/confirmation";
import { AssistantFeedbackContext, OperationErrorToast } from "../src/components/reui/operation-toast";
import { createErrorSession } from "../src/app/shell/assistant/assistant-client";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const render = (node: ReactNode) => act(async () => root.render(node));
const click = (text: string) => act(async () => {
  const target = Array.from(document.querySelectorAll("button")).find(button => button.textContent === text);
  expect(target).toBeTruthy(); target!.click();
});

it("focuses Cancel, cancels on Escape, restores focus, and accepts an operation only once", async () => {
  const results: boolean[] = [];
  function Harness() {
    const { confirm, dialog } = useConfirmation();
    return <><button onClick={async () => {
      results.push(await confirm({ title: "Delete backup?", description: "This cannot be undone.", action: "Delete", destructive: true }));
    }}>Open</button>{dialog}</>;
  }
  await render(<Harness />);
  const trigger = container.querySelector("button")!; trigger.focus();
  await click("Open");
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  expect(document.activeElement?.textContent).toBe("Cancel");
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(results).toEqual([false]);
  // Radix schedules focus restoration after the closing scope unmounts.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(document.activeElement).toBe(trigger);
  await click("Open"); await click("Delete");
  expect(results).toEqual([false, true]);
});

it("cancels a pending decision on unmount and rejects overlapping prompts", async () => {
  const results: boolean[] = [];
  function Harness() {
    const { confirm, dialog } = useConfirmation();
    return <><button onClick={() => {
      void confirm({ title: "First", description: "First", action: "Accept" }).then(result => results.push(result));
      void confirm({ title: "Second", description: "Second", action: "Accept" }).then(result => results.push(result));
    }}>Open</button>{dialog}</>;
  }
  await render(<Harness />); await click("Open");
  expect(results).toEqual([false]);
  await render(null); expect(results).toEqual([false, false]);
});

const report = { title: "Start failed", description: "Port 8080 is in use.\nSecond line.", appId: "demo.app" };
it("copies the complete error and offers no assistant action without Gateway", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  await render(<OperationErrorToast id="test" report={report} />);
  expect(container.textContent).not.toContain("Ask assistant");
  await click("Copy");
  expect(writeText).toHaveBeenCalledWith("Application: demo.app\n\nStart failed\n\nPort 8080 is in use.\nSecond line.");
  expect(container.textContent).toContain("Copied");
});

it("keeps errors available on clipboard failure and disables a stopped Gateway", async () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
  const ask = vi.fn();
  await render(<AssistantFeedbackContext.Provider value={{ installed: true, unavailableReason: "Start AI Gateway", ask }}><OperationErrorToast id="test" report={report} /></AssistantFeedbackContext.Provider>);
  await click("Copy");
  expect(container.textContent).toContain("Clipboard access failed");
  const button = Array.from(container.querySelectorAll("button")).find(item => item.textContent === "Ask assistant")!;
  expect(button.disabled).toBe(true); expect(button.parentElement?.title).toBe("Start AI Gateway");
  expect(ask).not.toHaveBeenCalled();
});

it("reuses a request ID on failed handoff and ignores double clicks while opening", async () => {
  let fail: (error: Error) => void = () => {};
  const ask = vi.fn(() => new Promise<void>((_, reject) => { fail = reject; }));
  await render(<AssistantFeedbackContext.Provider value={{ installed: true, ask }}><OperationErrorToast id="test" report={report} /></AssistantFeedbackContext.Provider>);
  await click("Ask assistant"); await click("Ask assistant");
  expect(ask).toHaveBeenCalledTimes(1);
  await act(async () => fail(new Error("Try again")));
  expect(container.textContent).toContain("Try again");
  await click("Ask assistant");
  expect(ask).toHaveBeenCalledTimes(2);
  expect(ask.mock.calls[1]).toEqual(ask.mock.calls[0]);
});

it.each([true, false])("creates an error session with capability-aware context (%s)", async context => {
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ harness: { available: true, capabilities: { appContext: context } } }))
    .mockRejectedValueOnce(new TypeError("connection lost"))
    .mockResolvedValueOnce(Response.json({ id: "fresh-session" }));
  vi.stubGlobal("fetch", fetchMock);
  const issue = vi.fn(async () => ({ token: "test-token" }));
  const result = await createErrorSession({ appId: "gateway", running: true, baseUrl: "https://gateway.test/api" }, issue, "demo.app", "same-request");
  expect(result.id).toBe("fresh-session");
  const first = fetchMock.mock.calls[1][1];
  expect(JSON.parse(first.body)).toEqual({ clientRequestId: "same-request", ...(context ? { appIds: ["demo.app"] } : {}) });
  expect(fetchMock.mock.calls[2][1].body).toBe(first.body);
});
