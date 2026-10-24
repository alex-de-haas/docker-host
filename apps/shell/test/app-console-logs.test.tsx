import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConsoleLogsPanel } from "../src/app/shell/dialogs/app-console-logs";
import type { CoreApp } from "../src/app/shell/types";

const transport = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../src/app/shell/core-transport.js", () => ({ fetchCore: transport.read }));
const app: CoreApp = { id: "example.media", displayName: "Media", version: "1.0.0", kind: "app", system: false,
  source: "manifest", operationStatus: "started", runtimeState: "running", capabilities: ["logs"] };
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  transport.read.mockReset().mockResolvedValue(Response.json({ text: "Recent output" }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const render = (current = app) => act(async () => root.render(<ConsoleLogsPanel key={current.id} app={current} coreOrigin="https://core.test" />));
const output = () => container.querySelector('[aria-label="Console output"]')!.textContent;
const refresh = () => act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Refresh")!.click());
const selectService = (name: string) => act(async () => [...container.querySelectorAll('[role="tab"]')].find(tab => tab.textContent === name)!
  .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));

it("loads the existing 200-line aggregate tail and refreshes it explicitly", async () => {
  await render();
  expect(transport.read).toHaveBeenCalledWith("https://core.test/api/apps/example.media/logs?tail=200", expect.objectContaining({ credentials: "include", signal: expect.any(AbortSignal) }));
  expect(output()).toBe("Recent output");
  transport.read.mockResolvedValueOnce(Response.json({ text: "New output" })); await refresh();
  expect(output()).toBe("New output"); expect(transport.read).toHaveBeenCalledTimes(2);
});

it("keeps per-service output separate and preserves the selected service on Refresh", async () => {
  transport.read.mockResolvedValue(Response.json({ text: "Combined", services: [{ service: "web", text: "Web output" }, { service: "worker", text: "Worker output" }] }));
  await render(); expect(output()).toBe("Web output");
  await selectService("worker"); expect(output()).toBe("Worker output");
  transport.read.mockResolvedValueOnce(Response.json({ services: [{ service: "web", text: "Updated web" }, { service: "worker", text: "Updated worker" }] }));
  await refresh(); expect(output()).toBe("Updated worker");
  transport.read.mockResolvedValueOnce(Response.json({ services: [{ service: "web", text: "Only web remains" }] }));
  await refresh(); expect(output()).toBe("Only web remains");
  expect(container.querySelector('[aria-label="Log service"]')).toBeNull();
});

it("shows empty output and recovers from a Core error on Refresh", async () => {
  transport.read.mockResolvedValueOnce(Response.json({ message: "Runtime logs unavailable" }, { status: 503 }));
  await render(); expect(container.querySelector('[role="alert"]')?.textContent).toContain("Runtime logs unavailable");
  transport.read.mockResolvedValueOnce(Response.json({ text: "", services: [] }));
  await refresh(); expect(output()).toBe("No logs");
  expect(container.textContent).not.toContain("Runtime logs unavailable");
});

it.each([false, true])("cancels a pending read on departure (manual Refresh: %s)", async manual => {
  let complete!: (response: Response) => void;
  if (manual) await render();
  transport.read.mockImplementationOnce(() => new Promise<Response>(resolve => { complete = resolve; }));
  if (manual) await refresh(); else await render();
  const signal = transport.read.mock.calls.at(-1)![1].signal as AbortSignal;
  expect(signal.aborted).toBe(false);
  await act(async () => root.render(<p>Another tab</p>)); expect(signal.aborted).toBe(true);
  await act(async () => complete(Response.json({ text: "Late output" })));
  expect(container.textContent).toBe("Another tab");
});

it("does not let a late previous-app response replace the new app's output", async () => {
  let complete!: (response: Response) => void;
  transport.read.mockImplementationOnce(() => new Promise<Response>(resolve => { complete = resolve; }));
  await render();
  const signal = transport.read.mock.calls[0][1].signal as AbortSignal;
  transport.read.mockResolvedValueOnce(Response.json({ text: "Other app output" }));
  await render({ ...app, id: "example.other" }); expect(signal.aborted).toBe(true);
  await act(async () => complete(Response.json({ text: "Old app output" })));
  expect(output()).toBe("Other app output");
});
