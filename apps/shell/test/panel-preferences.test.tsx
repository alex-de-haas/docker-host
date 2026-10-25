import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { panelKey, type UiPanel } from "@hosty-sdk/app/ui/types";
import { createPanelPreferenceStore, panelPreferenceKey, PanelPreferencesProvider, usePanelPreferences } from "../src/app/shell/chrome/panel-preferences";
import { PinnedToolButtons } from "../src/app/shell/chrome/pinned-tool-buttons";

const panel = (panelId: string): UiPanel => ({ panel: { appId: "app", installationId: "install-1", panelId }, label: panelId,
  appName: "App", endpoint: "web", route: "/panel", icon: null, origin: "https://app.test", available: true, canStart: false, state: "running", framePolicy: { microphone: false, popupEscape: false } });
const panels = [panel("chat"), panel("drafts")];
const catalog = { catalog: panels };
vi.mock("@hosty-sdk/app/ui/react", () => ({ useHostyUiHost: () => ({ subscribeSnapshot: () => () => {}, getSnapshot: () => catalog }) }));
let container: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => { localStorage.clear(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function Choices() {
  const prefs = usePanelPreferences();
  return <>{panels.map(item => <button key={panelKey(item.panel)} aria-pressed={prefs.isPinned(item)} onClick={() => prefs.setPinned(item, !prefs.isPinned(item))}>{item.label}</button>)}<span role="status">{prefs.error}</span></>;
}
const render = (userId = "alice", coreOrigin = "https://core.test") => act(async () => root.render(<PanelPreferencesProvider coreOrigin={coreOrigin} userId={userId} assistantAppId="app"><Choices /></PanelPreferencesProvider>));
const choices = () => [...container.querySelectorAll("button")];
it("isolates choices across users and Core origins, and restores the same user's choices without remounting the Shell", async () => {
  await render(); expect(choices().map(button => button.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
  await act(async () => { choices()[0].click(); choices()[1].click(); });
  await render("bob"); expect(choices().map(button => button.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
  await render("alice", "https://another-core.test"); expect(choices().map(button => button.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
  await render(); expect(choices().map(button => button.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
  const reloaded = createPanelPreferenceStore(panelPreferenceKey("https://core.test", "alice"));
  expect(reloaded.getSnapshot().overrides).toEqual({ [panelKey(panels[0].panel)]: false, [panelKey(panels[1].panel)]: true });
});
it("retains choices by panel reference across metadata changes while a reinstall gets its own identity", () => {
  const store = createPanelPreferenceStore("test"); store.setPinned(panels[0], false); store.setPinned(panels[1], true);
  const updated = { ...panels[1], label: "Renamed", route: "/new-route" };
  expect(store.getSnapshot().overrides[panelKey(updated.panel)]).toBe(true);
  expect(store.getSnapshot().overrides[panelKey({ ...updated.panel, installationId: "install-2" })]).toBeUndefined();
});
it("accepts only versioned boolean panel overrides and recovers malformed storage", () => {
  localStorage.setItem("test", JSON.stringify({ version: 1, pins: { [panelKey(panels[0].panel)]: false, [panelKey(panels[1].panel)]: "true", invalid: true } }));
  const store = createPanelPreferenceStore("test"); expect(store.getSnapshot().overrides).toEqual({ [panelKey(panels[0].panel)]: false });
  localStorage.setItem("test", "broken"); expect(store.getSnapshot().overrides).toEqual({});
  store.setPinned(panels[1], true); expect(createPanelPreferenceStore("test").getSnapshot().overrides[panelKey(panels[1].panel)]).toBe(true);
});
it("refreshes choices from another tab and merges its overrides when writing", async () => {
  await render(); const key = panelPreferenceKey("https://core.test", "alice");
  await act(async () => { localStorage.setItem(key, JSON.stringify({ version: 1, pins: { [panelKey(panels[0].panel)]: false } })); window.dispatchEvent(new StorageEvent("storage", { key })); });
  expect(choices()[0].getAttribute("aria-pressed")).toBe("false");
  await act(async () => choices()[1].click());
  expect(JSON.parse(localStorage.getItem(key)!).pins).toEqual({ [panelKey(panels[0].panel)]: false, [panelKey(panels[1].panel)]: true });
});
it("keeps a usable memory-only choice and explains storage failures", async () => {
  await render(); vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Quota exceeded", "QuotaExceededError"); });
  await act(async () => choices()[0].click());
  expect(choices()[0].getAttribute("aria-pressed")).toBe("false"); expect(container.querySelector('[role="status"]')?.textContent).toContain("until you reload");
  await act(async () => choices()[1].click());
  expect(choices().map(button => button.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
});
it("fits labels, falls back to icons, limits overflow, and restores labels after available space grows", async () => {
  let available = 500; const callbacks = new Set<() => void>();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return { width: this.hasAttribute("data-pinned-measure") ? 300 : available } as DOMRect; });
  vi.stubGlobal("ResizeObserver", class { constructor(private callback: () => void) { callbacks.add(callback); } observe() {} disconnect() { callbacks.delete(this.callback); } });
  const select = vi.fn();
  await act(async () => root.render(<PinnedToolButtons panels={panels} selectedKey={panelKey(panels[0].panel)} onSelect={select} />));
  expect(choices().map(button => button.textContent)).toEqual(["chat", "drafts"]);
  const resize = (width: number) => act(async () => { available = width; callbacks.forEach(callback => callback()); });
  await resize(100); expect(choices()).toHaveLength(2); expect(choices()[0].textContent).toBe(""); expect(choices()[0].getAttribute("aria-label")).toBe("Open App — chat");
  await act(async () => choices()[0].click()); expect(select).toHaveBeenCalledWith(panels[0]);
  await resize(32); expect(choices()).toHaveLength(1);
  await resize(20); expect(choices()).toHaveLength(0);
  await resize(500); expect(choices().map(button => button.textContent)).toEqual(["chat", "drafts"]); expect(choices()[0].getAttribute("aria-pressed")).toBe("true");
});
it("still supports in-memory choices when browser storage cannot be read at all", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Denied", "SecurityError"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Denied", "SecurityError"); });
  await render(); expect(container.querySelector('[role="status"]')?.textContent).toContain("cannot be saved");
  await act(async () => choices()[0].click()); expect(choices()[0].getAttribute("aria-pressed")).toBe("false");
});
