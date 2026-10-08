import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PrivateSourceConnections, SourceInstallDialog, withSourceConnections } from "../src/app/shell/dialogs/private-source-connections";
import { createInstallationClient } from "@hosty-sdk/app/install";
const { send, read } = vi.hoisted(() => ({ send: vi.fn(), read: vi.fn() }));
vi.mock("../src/app/shell/core-transport.js", () => ({ fetchCore: read }));
vi.mock("../src/app/shell/shell-context", () => ({ useShellActions: () => ({ coreOrigin: "https://core.test", sendCsrfJson: send }) }));
let root: Root; let container: HTMLDivElement;
const account = { id: "github-account", label: "Personal GitHub", status: "connected" };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: vi.fn() });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  vi.spyOn(window, "open").mockReturnValue(null);
  send.mockReset(); read.mockReset();
  read.mockImplementation(async (url: string) => Response.json(url.endsWith("source-access") ? { status: "available", hasGitSource: true, access: { git: { connectionId: account.id } } } : { connections: [account] }));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const button = (text: string) => [...document.querySelectorAll("button")].find(b => b.textContent === text)!;
async function choose(label: string, optionText: string) {
  const trigger = document.querySelector(`[aria-label="${label}"]`)!;
  await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  const option = [...document.querySelectorAll('[role="option"]')].find(node => node.textContent === optionText)!;
  await act(async () => option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
}
it("selects source bindings in Shell and prepares an update without submitting it", async () => {
  send.mockResolvedValue(Response.json({ message: "Review fixture" }, { status: 409 }));
  await act(async () => root.render(<PrivateSourceConnections appId="example.private" />));
  expect(container.textContent).toContain("Keep current (Personal GitHub)");
  expect(button("Review source update").disabled).toBe(true);
  await choose("Git source connection", "Public / no connection");
  await act(async () => button("Review source update").click());
  expect(send).toHaveBeenCalledWith("https://core.test/api/installations", { updateAppId: "example.private", sourceConnections: { clearGitConnection: true } }, "POST");
  expect(send).toHaveBeenCalledTimes(1);
});
it("keeps public installation available when account selection lacks permission", async () => {
  read.mockResolvedValue(Response.json({ code: "app_permission_required", message: "Permission required" }, { status: 403 }));
  send.mockResolvedValue(Response.json({ message: "Review fixture" }, { status: 409 }));
  const client = createInstallationClient({ baseUrl: "https://core.test/api/installations", request: send });
  await act(async () => root.render(<SourceInstallDialog client={client} coreOrigin="https://core.test" sendCsrfJson={send} onClose={() => {}} onInstalled={() => {}} />));
  expect(document.body.textContent).toContain("Public installation is still available.");
  expect(document.querySelector('a[href="https://core.test/install/permissions/hosty.shell"]')).not.toBeNull();
  const input = document.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "https://example.test/manifest.json");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(window.open).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][1]).toMatchObject({ manifestPath: "https://example.test/manifest.json" });
  expect(send.mock.calls[0][1]).not.toHaveProperty("sourceConnections");
});
it("retains private account selection when a runtime change triggers another review", async () => {
  send.mockImplementation(async () => Response.json({ id: "draft", approvalUrl: "https://core.test/install/confirm/draft", status: "draft", plan: null }));
  const original = createInstallationClient({ baseUrl: "/installations", request: send });
  const client = withSourceConnections(original, { manifestConnectionId: account.id });
  await client.prepare({ manifestPath: "https://example.test/manifest.json" });
  await client.prepare({ manifestPath: "https://example.test/manifest.json", selectedRuntime: "dev" });
  expect(send.mock.calls[1][1]).toEqual({ manifestPath: "https://example.test/manifest.json", selectedRuntime: "dev", sourceConnections: { manifestConnectionId: account.id } });
});

it("a selected manifest starts Core preparation directly without a Shell questionnaire", async () => {
  send.mockResolvedValue(Response.json({ message: "Review fixture" }, { status: 409 }));
  const client = createInstallationClient({ baseUrl: "https://core.test/api/installations", request: send });
  await act(async () => root.render(<SourceInstallDialog client={client} source={{ manifestPath: "https://example.test/manifest.json" }} confirmationWindow={null} coreOrigin="https://core.test" sendCsrfJson={send} onClose={() => {}} onInstalled={() => {}} />));
  expect(send.mock.calls[0][1]).toMatchObject({ manifestPath: "https://example.test/manifest.json" });
  expect(document.body.textContent).not.toContain("Manifest connection");
  expect(window.open).not.toHaveBeenCalled();
});
