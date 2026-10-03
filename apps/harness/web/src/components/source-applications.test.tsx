// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SourceApplications } from "./source-applications";
import { call } from "@/lib/api";
vi.mock("@/lib/api", () => ({ call: vi.fn() }));
let root: Root; let container: HTMLDivElement;
const draft = { id: "abc123", status: "draft", plan: null, updatePlan: { appId: "example.private", displayName: "Private app", targetVersion: "1.1", targetRuntime: "docker", changes: [] }, approvalUrl: "http://core.test/install/confirm/abc123" };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(call).mockImplementation(async (url) => Response.json(url.endsWith("source-access")
    ? { manifestUrl: "https://example.test/manifest.json", status: "reconnect-required", hasGitSource: true, access: { manifest: { connectionId: "removed" } } } : draft));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.resetAllMocks(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const button = (text: string) => [...container.querySelectorAll("button")].find(b => b.textContent === text)!;
async function fill(label: string, value: string) {
  await act(async () => {
    const node = [...container.querySelectorAll("label")].find(l => l.firstChild?.textContent === label)!.querySelector<HTMLInputElement | HTMLSelectElement>("input,select")!;
    const prototype = node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
it("reviews explicit replacement/public choices and freezes them before Core confirmation", async () => {
  const popup = { closed: false, opener: {}, location: { replace: vi.fn() }, close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  await act(async () => root.render(<SourceApplications connections={[{ id: "new", label: "New account" }]} />));
  await fill("Operation", "update"); await fill("Installed app ID", "example.private");
  await act(async () => button("Load source connections").click());
  expect(container.textContent).toContain("needs to be replaced");
  await fill("Manifest connection", "new"); await fill("Git source connection", "");
  await act(async () => button("Review request").click());
  expect(call).toHaveBeenLastCalledWith("/installations", { method: "POST", body: JSON.stringify({ updateAppId: "example.private", manifestPath: "https://example.test/manifest.json", sourceConnections: { manifestConnectionId: "new", clearGitConnection: true } }) });
  expect(container.textContent).toContain("Private app");
  vi.mocked(call).mockResolvedValueOnce(Response.json({ ...draft, status: "pending" }));
  await act(async () => button("Continue to Core confirmation").click());
  expect(call).toHaveBeenLastCalledWith("/installations/abc123/submit", { method: "POST", body: JSON.stringify({ settings: {}, autostart: true }) });
  expect(popup.location.replace).toHaveBeenCalledWith(draft.approvalUrl);
  expect([...container.querySelectorAll("select")].every(s => s.disabled)).toBe(true);
  expect(container.textContent).toContain("Waiting for confirmation in Hosty Core");
});
it("keeps Core permission refusal visible and does not offer confirmation without a plan", async () => {
  await act(async () => root.render(<SourceApplications connections={[]} />));
  await fill("Manifest path or URL", "https://example.test/manifest.json");
  vi.mocked(call).mockRejectedValueOnce(new Error("The app has not been granted 'apps.install'."));
  await act(async () => button("Review request").click());
  expect(container.querySelector('[role="alert"]')!.textContent).toContain("apps.install");
  expect(button("Continue to Core confirmation")).toBeUndefined();
});
