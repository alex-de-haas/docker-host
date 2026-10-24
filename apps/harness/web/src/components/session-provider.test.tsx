// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { SessionProvider } from "./session-provider";
import type { AssistantSession } from "../lib/assistant-api";
import { APP_SESSION_RESTORED } from "@hosty-sdk/app/browser-auth";
const api = vi.hoisted(() => ({ listAgentConnections: vi.fn(), setSessionProvider: vi.fn() }));
vi.mock("@/lib/assistant-api", () => api);
const providers = [
  { id: "first", name: "Codex", kind: "codex", available: true, revision: 1 },
  { id: "second", name: "Claude", kind: "claude", available: true, revision: 1 },
];
let container: HTMLDivElement, root: Root;
const change = vi.fn(), saving = vi.fn();
const chat = (extra = {}) => ({ id: "chat", connectionId: "first", connectionRevision: 1, providerLocked: false, ...extra }) as AssistantSession;
const render = async (session = chat()) => act(async () => root.render(
  <><textarea aria-label="Retained draft" defaultValue="" /><SessionProvider session={session} busy={false} onChange={change} onSavingChange={saving} /></>,
));
const trigger = () => container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
const select = async (id: string) => {
  await act(async () => trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(item => item.textContent?.includes(id === "first" ? "Codex" : "Claude"))!;
  expect(item).toBeDefined();
  await act(async () => item.click());
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.resetAllMocks();
  api.listAgentConnections.mockResolvedValue({ connections: providers, defaultId: "first" });
  api.setSessionProvider.mockImplementation(async (_id, connectionId) => chat({ connectionId }));
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it("applies dropdown changes immediately without a Select button", async () => {
  await render(); await select("second");
  expect(api.setSessionProvider).toHaveBeenCalledWith("chat", "second", false);
  expect(change).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "second" }));
  expect([...container.querySelectorAll("button")].some(button => button.textContent === "Select")).toBe(false);
});
it("adopts the default for an unbound empty chat", async () => {
  await render(chat({ connectionId: undefined }));
  expect(api.setSessionProvider).toHaveBeenCalledExactlyOnceWith("chat", "first", false);
});
it("does not substitute another account when the default is unavailable", async () => {
  api.listAgentConnections.mockResolvedValue({ connections: [{ ...providers[0], available: false }, providers[1]], defaultId: "first" });
  await render(chat({ connectionId: undefined }));
  expect(api.setSessionProvider).not.toHaveBeenCalled();
});
it("keeps a started chat's provider visible and disabled", async () => {
  await render(chat({ providerLocked: true }));
  expect(trigger().disabled).toBe(true);
  expect(trigger().textContent).toContain("Codex");
  expect(api.setSessionProvider).not.toHaveBeenCalled();
});
it("restores the confirmed selection and exposes a failed save", async () => {
  api.setSessionProvider.mockRejectedValueOnce(new Error("Could not save"));
  await render(); await select("second");
  expect(trigger().textContent).toContain("Codex");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not save");
  expect(change).not.toHaveBeenCalled();
  expect(saving.mock.calls.map(args => args[0])).toEqual([true, false]);
});
it("disables selection and reports pending persistence to the composer", async () => {
  let resolve!: (value: AssistantSession) => void;
  api.setSessionProvider.mockReturnValueOnce(new Promise<AssistantSession>(done => { resolve = done; }));
  await render(); await select("second");
  expect(trigger().disabled).toBe(true);
  expect(saving).toHaveBeenLastCalledWith(true);
  await act(async () => resolve(chat({ connectionId: "second" })));
  expect(saving).toHaveBeenLastCalledWith(false);
});
it("requires explicit account confirmation for an older unbound chat", async () => {
  await render(chat({ connectionId: undefined, providerLocked: true }));
  await select("second");
  expect(api.setSessionProvider).not.toHaveBeenCalled();
  expect([...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Confirm original provider")?.disabled).toBe(true);
  const confirmation = container.querySelector<HTMLButtonElement>('[role="checkbox"]')!;
  const label = container.querySelector<HTMLLabelElement>(`label[for="${confirmation.id}"]`)!;
  expect(label.textContent).toContain("This older chat used the selected provider and account.");
  await act(async () => label.click());
  expect(confirmation.getAttribute("aria-checked")).toBe("true");
  await select("first");
  expect(confirmation.getAttribute("aria-checked")).toBe("false");
  expect([...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Confirm original provider")?.disabled).toBe(true);
  await select("second");
  await act(async () => label.click());
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Confirm original provider")!.click());
  expect(api.setSessionProvider).toHaveBeenCalledWith("chat", "second", true);
});

it("rebinds the selected provider when credentials advance before the first message", async () => {
  api.listAgentConnections.mockResolvedValue({ connections: [{ ...providers[0], revision: 2 }], defaultId: "first" });
  api.setSessionProvider.mockResolvedValueOnce(chat({ connectionRevision: 2 }));
  await render(); await select("first");
  expect(api.setSessionProvider).toHaveBeenCalledExactlyOnceWith("chat", "first", false);
  expect(change).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "first", connectionRevision: 2 }));
});
it("does not save when reselecting an unchanged provider binding", async () => {
  await render(); await select("first");
  expect(api.setSessionProvider).not.toHaveBeenCalled();
});

const refresh = (event = "focus") => act(async () => { window.dispatchEvent(new Event(event)); });
const retryRead = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Retry providers");
it.each(["focus", APP_SESSION_RESTORED])("clears a stale provider read error after %s recovery without changing the selection or draft", async event => {
  api.listAgentConnections.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  await render(); expect(container.querySelector('[role="alert"]')?.textContent).toBe("Failed to fetch");
  const draft = container.querySelector<HTMLTextAreaElement>('[aria-label="Retained draft"]')!; draft.value = "Unsent message and refs stay here";
  await refresh(event);
  expect(api.listAgentConnections).toHaveBeenCalledTimes(2); expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(trigger().textContent).toContain("Codex"); expect(api.setSessionProvider).not.toHaveBeenCalled(); expect(change).not.toHaveBeenCalled();
  expect(container.querySelector('[aria-label="Retained draft"]')).toBe(draft); expect(draft.value).toBe("Unsent message and refs stay here");
});

it("offers explicit provider-read Retry instead of claiming a failed roster is empty", async () => {
  api.listAgentConnections.mockRejectedValueOnce(new TypeError("Failed to fetch")); await render();
  await act(async () => trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(document.body.textContent).not.toContain("Add a provider in Hosty Harness settings.");
  expect(retryRead()).toBeDefined();
  await act(async () => retryRead()!.click());
  expect(api.listAgentConnections).toHaveBeenCalledTimes(2); expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(api.setSessionProvider).not.toHaveBeenCalled(); expect(change).not.toHaveBeenCalled();
});

it.each(["focus", APP_SESSION_RESTORED])("does not auto-save a newly available default during a %s read refresh", async event => {
  api.listAgentConnections.mockResolvedValueOnce({ connections: [], defaultId: null }); await render(chat({ connectionId: undefined }));
  expect(api.setSessionProvider).not.toHaveBeenCalled();
  await refresh(event); expect(api.listAgentConnections).toHaveBeenCalledTimes(2);
  expect(api.setSessionProvider).not.toHaveBeenCalled(); expect(change).not.toHaveBeenCalled(); expect(saving).not.toHaveBeenCalled();
  expect(trigger().textContent).toContain("Choose provider");
});

it("keeps save errors distinct from a recovered roster read", async () => {
  api.setSessionProvider.mockRejectedValueOnce(new Error("Selection conflict")); await render(); await select("second");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Selection conflict");
  api.listAgentConnections.mockRejectedValueOnce(new TypeError("Failed to fetch")); await refresh();
  expect([...container.querySelectorAll('[role="alert"]')].map(item => item.textContent)).toEqual(expect.arrayContaining(["Failed to fetch", "Selection conflict"]));
  await refresh(APP_SESSION_RESTORED);
  expect([...container.querySelectorAll('[role="alert"]')].map(item => item.textContent)).toEqual(["Selection conflict"]);
  expect(api.setSessionProvider).toHaveBeenCalledOnce(); expect(trigger().textContent).toContain("Codex");
});

it("ignores an older failed read after a newer roster has recovered", async () => {
  await render(); let rejectOld!: (cause: Error) => void;
  api.listAgentConnections.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; })); await refresh();
  api.listAgentConnections.mockResolvedValueOnce({ connections: [{ ...providers[0], name: "Recovered Codex" }], defaultId: "first" }); await refresh();
  await act(async () => rejectOld(new TypeError("Old offline result")));
  expect(container.querySelector('[role="alert"]')).toBeNull(); expect(trigger().textContent).toContain("Recovered Codex");
  expect(api.setSessionProvider).not.toHaveBeenCalled();
});

it("ignores stale successful reads and disposed reads without adopting a default", async () => {
  await render(); let finishOld!: (value: unknown) => void;
  api.listAgentConnections.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; })); await refresh();
  api.listAgentConnections.mockResolvedValueOnce({ connections: [{ ...providers[0], name: "Current Codex" }], defaultId: "first" }); await refresh();
  await act(async () => finishOld({ connections: [{ ...providers[0], name: "Stale Codex" }], defaultId: "first" }));
  expect(trigger().textContent).toContain("Current Codex");
  let finishDisposed!: (value: unknown) => void;
  api.listAgentConnections.mockImplementationOnce(() => new Promise(resolve => { finishDisposed = resolve; }));
  await render(chat({ id: "new-empty-chat", connectionId: undefined }));
  await act(async () => root.unmount()); root = createRoot(container);
  await act(async () => finishDisposed({ connections: providers, defaultId: "first" }));
  expect(api.setSessionProvider).not.toHaveBeenCalled(); expect(change).not.toHaveBeenCalled();
});
