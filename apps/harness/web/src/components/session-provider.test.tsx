// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { SessionProvider } from "./session-provider";
import type { AssistantSession } from "../lib/assistant-api";
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
  <SessionProvider session={session} busy={false} onChange={change} onSavingChange={saving} />,
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
  vi.clearAllMocks();
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
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Confirm original provider")!.click());
  expect(api.setSessionProvider).toHaveBeenCalledWith("chat", "second", true);
});
