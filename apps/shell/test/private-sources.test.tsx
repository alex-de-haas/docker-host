import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PrivateSourceConnections, SourceInstallDialog } from "../src/app/shell/dialogs/private-source-connections";
import { createInstallationClient } from "@hosty-sdk/app/install";
const send = vi.fn();
vi.mock("../src/app/shell/shell-context", () => ({
  useShellActions: () => ({ coreOrigin: "https://core.test" }),
  useShellState: () => ({ state: { apps: [{ id: "hosty.harness", displayName: "Hosty Harness", embeddedUrl: "https://harness.test/settings", grantedCorePermissions: ["apps.sources"] }] } }),
}));
let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("fetch", vi.fn());
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: vi.fn() });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container); send.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it("links to an authorized source app without reading source connections", async () => {
  await act(async () => root.render(<PrivateSourceConnections appId="example.private" />));
  expect(fetch).not.toHaveBeenCalled();
  const link = container.querySelector("a")!;
  expect(link.textContent).toBe("Open Hosty Harness");
  expect(link.href).toContain("/api/apps/hosty.harness/open?redirectUri=");
  expect(container.querySelector("select")).toBeNull();
});
it("keeps public installation available without reading or sending provider connections", async () => {
  send.mockResolvedValue(Response.json({ message: "Review fixture" }, { status: 409 }));
  const client = createInstallationClient({ baseUrl: "https://core.test/api/installations", request: send });
  await act(async () => root.render(<SourceInstallDialog client={client} source={{ manifestPath: "https://example.test/manifest.json" }} coreOrigin="https://core.test" sendCsrfJson={send} onClose={() => {}} onInstalled={() => {}} />));
  expect(fetch).not.toHaveBeenCalled(); expect(document.querySelector("select")).toBeNull();
  await act(async () => [...document.querySelectorAll("button")].find(b => b.textContent === "Review installation")!.click());
  expect(send.mock.calls[0][1]).toMatchObject({ manifestPath: "https://example.test/manifest.json" });
  expect(send.mock.calls[0][1]).not.toHaveProperty("sourceConnections");
});
