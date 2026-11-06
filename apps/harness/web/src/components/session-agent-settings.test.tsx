// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionAgentSettings, type AgentSettingsNotice } from "./session-agent-settings";
import * as api from "@/lib/assistant-api";
import * as profiles from "@/lib/profiles-api";
vi.mock("@/lib/assistant-api", () => ({ getSessionModels: vi.fn(), setSessionModel: vi.fn(), listAgentConnections: vi.fn(), setSessionProvider: vi.fn() }));
vi.mock("@/lib/profiles-api", () => ({ listProfiles: vi.fn(), selectSessionProfile: vi.fn() }));
const record: api.AssistantSession = { id: "chat", title: "Chat", createdAt: "", status: "idle", connectionId: "account", connectionRevision: 1,
  providerLocked: true, profileLocked: true, selectionRevision: 7, executionSelection: { model: "first", reasoningEffort: "medium" } };
const catalog: api.ModelCatalog = { revision: "one", models: [{ id: "first", label: "First", efforts: [
  { id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" },
] }] };
let root: Root, container: HTMLDivElement;
const changed = vi.fn();
function Subject({ initial = record }: { initial?: api.AssistantSession }) {
  const [session, setSession] = useState(initial), [busy, setBusy] = useState(false), [notice, setNotice] = useState<AgentSettingsNotice | null>(null);
  return <><textarea aria-label="Draft" defaultValue="Keep my draft" /><SessionAgentSettings session={session} busy={busy} onSavingChange={setBusy}
    onChange={value => { changed(value); setSession(value); }} onNoticeChange={setNotice} /><button disabled={busy} aria-label="Send">Send</button>
    {notice?.text && <p role="alert">{notice.text}</p>}</>;
}
const trigger = () => document.querySelector<HTMLButtonElement>('button[aria-label^="Agent settings:"]')!;
const open = () => act(async () => trigger().click());
const key = (node: Element, value: string) => act(async () => node.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })));
const render = (initial = record) => act(async () => root.render(<Subject initial={initial} />));
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.mocked(api.getSessionModels).mockResolvedValue(catalog);
  vi.mocked(api.listAgentConnections).mockResolvedValue({ connections: [{ id: "account", name: "My account", kind: "codex", available: true, revision: 1 }], defaultId: "account" } as Awaited<ReturnType<typeof api.listAgentConnections>>);
  vi.mocked(profiles.listProfiles).mockResolvedValue({ profiles: [], revision: 1, defaultId: null });
  vi.mocked(api.setSessionModel).mockImplementation(async (_id, selection, revision) => ({ ...record, executionSelection: selection, selectionRevision: revision + 1 }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
it("has one trigger and read-only provider/profile rows after start, with current labels and retained draft", async () => {
  await render();
  expect(trigger().textContent).toBe("First · Medium");
  expect(document.querySelector('[aria-label="Model"]')).toBeNull();
  await open();
  expect(document.querySelector('[aria-label="Current provider"]')?.textContent).toBe("My account");
  expect(document.querySelector('[aria-label="Current agent profile"]')?.textContent).toBe("No profile");
  expect(document.querySelector('button[aria-label^="Provider:"]')).toBeNull();
  expect(document.querySelector('[role="slider"]')?.getAttribute("aria-valuetext")).toBe("Medium");
  await key(document.activeElement!, "Escape");
  expect(document.querySelector('textarea')!.value).toBe("Keep my draft");
  expect(api.setSessionModel).not.toHaveBeenCalled();
});
it("persists keyboard effort once, blocks Send during persistence and keeps slider focus after success", async () => {
  let finish!: (value: api.AssistantSession) => void;
  vi.mocked(api.setSessionModel).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render(); await open();
  const slider = document.querySelector<HTMLElement>('[role="slider"]')!;
  await act(async () => slider.focus()); await key(slider, "ArrowRight");
  expect(api.setSessionModel).toHaveBeenCalledExactlyOnceWith("chat", { model: "first", reasoningEffort: "high" }, 7);
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.disabled).toBe(true);
  await act(async () => finish({ ...record, selectionRevision: 8, executionSelection: { model: "first", reasoningEffort: "high" } }));
  expect(document.querySelector('[role="slider"]')).toBe(slider);
  expect(document.activeElement).toBe(slider);
  expect(trigger().textContent).toBe("First · High");
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.disabled).toBe(false);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Use default effort"]')!.click());
  expect(api.setSessionModel).toHaveBeenLastCalledWith("chat", { model: "first", reasoningEffort: null }, 8);
  expect(trigger().textContent).toBe("First · Default effort");
});
it("keeps the controller alive when the panel closes during a failed save and exposes the error outside", async () => {
  let fail!: (error: Error) => void;
  vi.mocked(api.setSessionModel).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  await render(); await open(); await key(document.querySelector('[role="slider"]')!, "ArrowLeft");
  await key(document.querySelector('[role="slider"]')!, "Escape");
  await act(async () => fail(new Error("Selection changed; refresh this chat.")));
  expect(trigger().textContent).toBe("First · Medium");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Selection changed");
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.disabled).toBe(false);
  await open();
  expect(document.querySelector('[role="slider"]')?.getAttribute("aria-valuetext")).toBe("Medium");
  expect(changed).not.toHaveBeenCalled();
});
it("uses binary thinking and a distinct default instead of an ordinal slider", async () => {
  vi.mocked(api.getSessionModels).mockResolvedValue({ revision: "binary", models: [{ id: "first", label: "First", defaultEffort: "true", efforts: [{ id: "false", label: "Off" }, { id: "true", label: "On" }] }] });
  await render({ ...record, executionSelection: { model: "first", reasoningEffort: null } }); await open();
  expect(document.querySelector('[role="slider"]')).toBeNull();
  const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(document.querySelector('[aria-label="Selected reasoning effort"]')?.textContent).toBe("Default effort");
  await act(async () => toggle.click());
  expect(api.setSessionModel).toHaveBeenCalledWith("chat", { model: "first", reasoningEffort: "false" }, 7);
});
it("preserves custom unknown selections when reasoning is unsupported and allows explicit default recovery", async () => {
  vi.mocked(api.getSessionModels).mockResolvedValue({ revision: "empty", models: [{ id: "first", label: "First", efforts: [] }] });
  await render(); await open();
  expect(document.querySelector('[role="slider"]')).toBeNull();
  expect(document.querySelector('[role="switch"]')).toBeNull();
  expect(document.querySelector('[aria-label="Selected reasoning effort"]')?.textContent).toBe("medium (unavailable)");
  expect(document.body.textContent).toContain("does not offer reasoning levels");
  expect(api.setSessionModel).not.toHaveBeenCalled();
});
it("locks model and effort for accepted tasks but keeps the settings panel readable", async () => {
  await render({ ...record, taskExecutionId: "task" }); await open();
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Model"]')!.disabled).toBe(true);
  expect(document.querySelector('[role="slider"]')?.getAttribute("data-disabled")).not.toBeNull();
  expect(document.body.textContent).toContain("fixed for this task");
  expect(trigger().disabled).toBe(false);
});
it("adopts an empty chat's default provider without opening settings", async () => {
  vi.mocked(api.setSessionProvider).mockResolvedValue({ ...record, providerLocked: false, profileLocked: false });
  await render({ ...record, connectionId: undefined, providerLocked: false, profileLocked: false });
  expect(api.setSessionProvider).toHaveBeenCalledExactlyOnceWith("chat", "account", false);
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
});
it("keeps the common panel open when provider selection replaces the connection binding", async () => {
  vi.mocked(api.listAgentConnections).mockResolvedValue({ connections: [
    { id: "account", name: "My account", kind: "codex", available: true, revision: 1 },
    { id: "other", name: "Other account", kind: "claude", available: true, revision: 2 },
  ], defaultId: "account" } as Awaited<ReturnType<typeof api.listAgentConnections>>);
  vi.mocked(api.setSessionProvider).mockResolvedValue({ ...record, providerLocked: false, profileLocked: false, connectionId: "other", connectionRevision: 2 });
  await render({ ...record, providerLocked: false, profileLocked: false }); await open();
  await key(document.querySelector('button[aria-label^="Provider:"]')!, "ArrowDown");
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(e => e.textContent?.startsWith("Other account"))!.click());
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelector('button[aria-label="Model"]')).not.toBeNull();
  expect(document.querySelector('button[aria-label^="Provider:"]')?.textContent).toContain("Other account");
});
