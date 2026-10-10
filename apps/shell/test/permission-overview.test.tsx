import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsPermissionsSection, type PermissionOverviewEntry } from "../src/app/shell/pages/settings-permissions-section";
import type { CoreApp } from "../src/app/shell/types";

let root: Root, container: HTMLDivElement;
const provider = { id: "example.whisper", displayName: "Whisper", icon: null, iconUrl: "/api/apps/example.whisper/assets/icon.png" };
const providerApp: CoreApp = {
  id: provider.id, displayName: provider.displayName, version: "1.0.0", kind: "app", system: false,
  source: "local", operationStatus: "idle", runtimeState: "stopped", capabilities: [],
};
let entries: PermissionOverviewEntry[];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  entries = [
    { id: "apps.read", kind: "permission", description: "List applications and read their state", apps: [] },
    { id: "speech-to-text", kind: "role", description: "Provide speech recognition", apps: [provider] },
    { id: "otlp-collector", kind: "provisioning", description: "Legacy collector provisioning", apps: [] },
  ];
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ entries })));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const render = (apps: CoreApp[] = []) => act(async () => root.render(<SettingsPermissionsSection coreOrigin="https://core.test" apps={apps} />));
const refresh = () => act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "Refresh")!.click());
const search = (value: string) => act(async () => {
  const input = container.querySelector("input")!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});

it("shows all catalogue entries, descriptions and app icons/names without editable grants", async () => {
  await render();
  expect(container.textContent).toContain("apps.read");
  expect(container.textContent).toContain("No apps");
  expect(container.textContent).toContain("Provider role");
  expect(container.textContent).toContain("Legacy provisioning");
  expect(container.textContent).toContain("Whisper");
  expect(container.querySelector("img")?.getAttribute("src")).toBe("/api/core/api/apps/example.whisper/assets/icon.png");
  expect(container.querySelectorAll('input[type="checkbox"], [role="switch"]')).toHaveLength(0);
});

it("searches app names, identifiers and descriptions and explains no matches", async () => {
  await render();
  for (const query of ["WHISPER", "example.whisper", "recognition"]) {
    await search(query);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(container.querySelector("tbody")?.textContent).toContain("speech-to-text");
  }
  await search("absent");
  expect(container.textContent).toContain("No permissions, roles or apps match");
  await search("");
  expect(container.querySelectorAll("tbody tr")).toHaveLength(3);
});

it("clears stale holders on failed refresh and supports retry", async () => {
  await render();
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ message: "Access was revoked." }, { status: 403 }));
  await refresh();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Access was revoked.");
  expect(container.querySelector("table")).toBeNull();
  entries = [];
  await refresh();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain("No permissions or roles are available.");
});

it("refreshes after returning from Core and after live grant changes", async () => {
  await render();
  entries = entries.map(entry => ({ ...entry, apps: [] }));
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(container.querySelector("tbody")?.textContent).not.toContain("Whisper");
  const before = vi.mocked(fetch).mock.calls.length;
  await render([{ ...providerApp, grantedCorePermissions: ["apps.read"] }]);
  expect(vi.mocked(fetch).mock.calls.length).toBe(before + 1);
});

it("shows loading and explains an older Core without the endpoint", async () => {
  let resolve!: (response: Response) => void;
  vi.mocked(fetch).mockReturnValueOnce(new Promise<Response>(done => { resolve = done; }));
  await render();
  expect(container.textContent).toContain("Loading app permissions");
  await act(async () => resolve(new Response(null, { status: 404 })));
  expect(container.textContent).toContain("Update Core to 0.128.0");
});

it("ignores an older response after the app authority changed", async () => {
  let resolveOld!: (response: Response) => void;
  vi.mocked(fetch).mockReturnValueOnce(new Promise<Response>(done => { resolveOld = done; }));
  await render();
  const oldEntries = entries;
  entries = entries.map(entry => ({ ...entry, apps: [] }));
  await render([{ ...providerApp, grantedCorePermissions: [] }]);
  await act(async () => resolveOld(Response.json({ entries: oldEntries })));
  expect(container.querySelector("tbody")?.textContent).not.toContain("Whisper");
  expect(container.querySelectorAll("tbody tr")).toHaveLength(3);
});
