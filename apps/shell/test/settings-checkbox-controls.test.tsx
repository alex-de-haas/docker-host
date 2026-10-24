import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CheckboxRow } from "../src/app/shell/ui";
import { SettingsAgentsSection } from "../src/app/shell/pages/settings-agents-section";
import { SharedMountAppsDialog } from "../src/app/shell/pages/shared-mount-apps-dialog";
import { SourceProviders } from "../src/app/shell/pages/source-providers";
import type { CoreApp, CoreGlobalMount } from "../src/app/shell/types";

const source = vi.hoisted(() => ({ call: vi.fn(), send: vi.fn() }));
vi.mock("../src/app/shell/source/source-connections", () => ({
  createSourceConnectionsApi: () => source,
}));

let root: Root, container: HTMLDivElement;
const directory = {
  revision: "reviewed",
  assistants: [{ id: "assistant", displayName: "Assistant" }],
  targets: [{ id: "notes", displayName: "Notes", offered: false, runtimeState: "running",
    interfaces: [{ key: "default", readiness: "ready" }], skills: [], assistantIds: [] }],
};
const sourceProfile = {
  providers: [{ id: "github", displayName: "GitHub", authenticationMethods: ["device"], capabilities: [] }],
  connections: [],
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(directory)));
  source.call.mockImplementation(async () => Response.json(sourceProfile));
  source.send.mockImplementation(async () => Response.json({
    id: "device-attempt", status: "pending", userCode: "ABCD", verificationUri: "https://github.com/login/device",
    expiresAt: "2026-11-01T12:00:00Z", interval: 10,
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

const checkbox = (name: string) => document.querySelector<HTMLButtonElement>('[role="checkbox"][aria-label="' + name + '"]')!;
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === text)!;

it("keeps CheckboxRow label activation, boolean values and disabled behavior", async () => {
  const changed = vi.fn();
  function Example({ disabled = false }: { disabled?: boolean }) {
    const [checked, setChecked] = useState(false);
    return <CheckboxRow label="Enable updates" checked={checked} disabled={disabled}
      onChange={next => { changed(next); setChecked(next); }} />;
  }
  await act(async () => root.render(<Example />));
  const label = container.querySelector("label")!;
  await act(async () => label.click());
  expect(changed).toHaveBeenLastCalledWith(true);
  expect(container.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("true");
  await act(async () => label.click());
  expect(changed).toHaveBeenLastCalledWith(false);
  await act(async () => root.render(<Example disabled />));
  await act(async () => container.querySelector("label")!.click());
  expect(changed).toHaveBeenCalledTimes(2);
});

it("keeps offer and assistant choices disabled during a reviewed directory mutation", async () => {
  const send = vi.fn();
  let finish!: (response: Response) => void;
  send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => root.render(<SettingsAgentsSection coreOrigin="https://core.test" sendCsrfJson={send} />));
  await act(async () => checkbox("Offer Notes to agents").click());
  expect(send).toHaveBeenCalledExactlyOnceWith("https://core.test/api/core/agents/notes", { revision: "reviewed", offered: true }, "PUT");
  expect(checkbox("Offer Notes to agents").disabled).toBe(true);
  expect(checkbox("Allow Assistant to use Notes MCP").disabled).toBe(true);
  await act(async () => checkbox("Allow Assistant to use Notes MCP").click());
  expect(send).toHaveBeenCalledTimes(1);
  await act(async () => finish(Response.json({ ...directory, targets: directory.targets.map(target => ({ ...target, offered: true })) })));
  expect(checkbox("Offer Notes to agents").disabled).toBe(false);
  expect(checkbox("Offer Notes to agents").getAttribute("aria-checked")).toBe("true");
});

it("preserves mount conflicts, selected removal, exact bindings and pending locks", async () => {
  const mount = { name: "disk", hostPath: "/host/disk", mode: "rw" } as CoreGlobalMount;
  const app = {
    id: "media", displayName: "Media", selectedRuntime: "docker", runtimeProfiles: [{ key: "docker", type: "docker" }],
    mounts: [
      { key: "library", mode: "rw", required: true, multiple: false, bindings: [{ globalMountName: "disk" }] },
      { key: "occupied", mode: "rw", required: false, multiple: false, bindings: [{ globalMountName: "other" }] },
    ],
  } as unknown as CoreApp;
  let finish!: () => void;
  const save = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const refresh = vi.fn(async () => undefined), close = vi.fn();
  await act(async () => root.render(<SharedMountAppsDialog mount={mount} apps={[app]} onSave={save}
    onRefresh={refresh} onReload={async () => undefined} onClose={close} onSaved={vi.fn()} />));
  expect(checkbox("Media: library").getAttribute("aria-checked")).toBe("true");
  expect(checkbox("Media: occupied").disabled).toBe(true);
  await act(async () => checkbox("Media: occupied").click());
  expect(button("Save changes").disabled).toBe(true);
  await act(async () => checkbox("Media: library").closest("label")!.click());
  expect(checkbox("Media: library").getAttribute("aria-checked")).toBe("false");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("This app cannot start until its required slot has a folder.");
  await act(async () => button("Save changes").click());
  expect(save).toHaveBeenCalledExactlyOnceWith("disk", { appId: "media", keys: [], expectedKeys: ["library"] });
  expect(checkbox("Media: library").disabled).toBe(true);
  expect(checkbox("Media: occupied").disabled).toBe(true);
  await act(async () => finish());
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
});

it("keeps the private repository scope controlled by its labelled source checkbox", async () => {
  await act(async () => root.render(<SourceProviders coreOrigin="https://core.test" sendCsrfJson={vi.fn()} />));
  await act(async () => button("Add connection").click());
  const privateAccess = document.querySelector<HTMLButtonElement>('[role="dialog"] [role="checkbox"]')!;
  expect(privateAccess.getAttribute("aria-checked")).toBe("false");
  await act(async () => privateAccess.closest("label")!.click());
  expect(privateAccess.getAttribute("aria-checked")).toBe("true");
  await act(async () => button("Connect GitHub").click());
  expect(source.send).toHaveBeenCalledExactlyOnceWith("/source-connections/device",
    { label: "", provider: "github", token: undefined, privateRepositories: true });
});
