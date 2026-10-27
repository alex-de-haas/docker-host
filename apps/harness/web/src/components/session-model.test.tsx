// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { SessionModel } from "./session-model";
import * as api from "@/lib/assistant-api";
vi.mock("@/lib/assistant-api", () => ({ getSessionModels: vi.fn(), setSessionModel: vi.fn() }));
let root: Root, container: HTMLDivElement;
const record: api.AssistantSession = { id: "chat", title: "Chat", createdAt: "", status: "idle", connectionId: "account", selectionRevision: 7, executionSelection: { model: "first", reasoningEffort: "high" } };
const changed = vi.fn(), saving = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api.getSessionModels).mockResolvedValue({ revision: "catalog", models: [
    { id: "first", label: "First", efforts: [{ id: "high", label: "High" }] },
    { id: "second", label: "Second", efforts: [{ id: "xhigh", label: "Extra high" }] },
  ] });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
const render = (busy = false) => act(async () => root.render(<SessionModel session={record} busy={busy} onChange={changed} onSavingChange={saving} />));
async function choose(label: string, text: string) {
  await act(async () => {
    const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    button.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowDown", bubbles: true}));
  });
  await act(async () => { [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(e=>e.textContent === text)!.click(); });
}
it("shows supported effort choices and atomically resets incompatible effort with a model change", async () => {
  vi.mocked(api.setSessionModel).mockResolvedValue({ ...record, selectionRevision: 8, executionSelection: { model: "second", reasoningEffort: null } });
  await render(); await choose("Model", "Second");
  expect(api.setSessionModel).toHaveBeenCalledExactlyOnceWith("chat", { model: "second", reasoningEffort: null }, 7);
  expect(changed).toHaveBeenCalledWith(expect.objectContaining({selectionRevision: 8}));
  expect(saving.mock.calls).toEqual([[true], [false]]);
});
it("disables both selectors during execution without fetching repeatedly", async () => {
  await render(); await render(true);
  expect([...container.querySelectorAll("button")].every(button=>button.disabled)).toBe(true);
  expect(api.getSessionModels).toHaveBeenCalledTimes(1);
  expect(api.setSessionModel).not.toHaveBeenCalled();
});
it("preserves the current selection and reports a stale-update error", async () => {
  vi.mocked(api.setSessionModel).mockRejectedValue(new Error("Model selection changed. Refresh this chat before retrying."));
  await render(); await choose("Reasoning effort", "Default");
  expect(api.setSessionModel).toHaveBeenCalledWith("chat", {model: "first", reasoningEffort: null}, 7);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Model selection changed");
  expect(changed).not.toHaveBeenCalled();
  expect(container.querySelector('button[aria-label="Reasoning effort"]')?.textContent).toBe("High");
});

it("recovers an unavailable model catalog explicitly without changing the selected model or effort", async () => {
  vi.mocked(api.getSessionModels).mockRejectedValueOnce(new Error("Model catalog temporarily unavailable"));
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Model catalog temporarily unavailable");
  expect(api.setSessionModel).not.toHaveBeenCalled();
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Retry models")!.click());
  expect(api.getSessionModels).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('[aria-label="Model"]')?.textContent).toBe("First");
  expect(container.querySelector('[aria-label="Reasoning effort"]')?.textContent).toBe("High");
  expect(api.setSessionModel).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
});

it("scopes catalog labels and errors to the current session and connection, including no connection", async () => {
  await render();
  expect(container.querySelector('[aria-label="Model"]')?.textContent).toBe("First");
  let rejectRead!: (cause: Error) => void;
  vi.mocked(api.getSessionModels).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRead = reject; }));
  const next = { ...record, id: "other-chat", connectionId: "other-account", connectionRevision: 2 };
  await act(async () => root.render(<SessionModel session={next} busy={false} onChange={changed} onSavingChange={saving} />));
  expect(container.querySelector('[aria-label="Model"]')?.textContent).toBe("first (unavailable)");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await act(async () => rejectRead(new Error("Other account catalog unavailable")));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Other account catalog unavailable");
  await act(async () => root.render(<SessionModel session={{ ...next, connectionId: undefined }} busy={false} onChange={changed} onSavingChange={saving} />));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect([...container.querySelectorAll("button")].some(button => button.textContent === "Retry models")).toBe(false);
  expect(api.getSessionModels).toHaveBeenCalledTimes(2);
  expect(api.setSessionModel).not.toHaveBeenCalled();
});

it("keeps an accepted task's model and effort selectors locked while its chat is idle", async () => {
  await act(async () => root.render(<SessionModel session={{ ...record, taskExecutionId: "task-attempt" }} busy={false} onChange={changed} onSavingChange={saving} />));
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Model"]')!.disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Reasoning effort"]')!.disabled).toBe(true);
  expect(api.setSessionModel).not.toHaveBeenCalled();
});
