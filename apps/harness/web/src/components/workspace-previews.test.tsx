// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspacePreviews } from "./workspace-previews";
import { developmentRequest } from "@/lib/development-api";
vi.mock("@/lib/development-api", () => ({ developmentRequest: vi.fn() }));
let root: Root, container: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); });
function reply(app: object) { return { environments: [{ id: "child", label: "Retained preview", state: "running", previewUrl: "http://core.test" }], instances: [], applications: { child: { state: "ready", apps: [{ id: "demo", displayName: "Demo App", runtimeState: "running", previewUrl: "http://core.test/open", ...app }] } } }; }
it("shows building, failure and restart requirements without claiming hot reload compiled the source", async () => {
  vi.useFakeTimers(); vi.mocked(developmentRequest).mockResolvedValue(reply({ restartRequired: true, development: { reloadMode: "application-managed", manifestState: "changed", restartRequired: true }, launchProgress: { stage: "building", buildState: "building", service: "web", changedAt: "2026-10-16T12:00:00Z" } }));
  await act(async () => root.render(<WorkspacePreviews workspaceId="work" />));
  expect(container.textContent).toContain("Environment build: Building"); expect(container.textContent).toContain("Restart required · Source manifest or location changed");
  expect(container.textContent).toContain("Reload and compilation are managed by the application");
  vi.mocked(developmentRequest).mockResolvedValue(reply({ runtimeState: "stopped", lastError: "Fixture build failed", launchProgress: { stage: "failed", buildState: "failed", changedAt: "2026-10-16T12:01:00Z" } }));
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(container.textContent).toContain("Environment build: Failed"); expect(container.textContent).toContain("Fixture build failed");
  expect(container.textContent).not.toContain("Restart required ·");
});
it("keeps missing observations unknown and clears stale success after read failure", async () => {
  vi.useFakeTimers(); vi.mocked(developmentRequest).mockResolvedValue(reply({ development: { reloadMode: "application-managed", manifestState: "unavailable" } }));
  await act(async () => root.render(<WorkspacePreviews workspaceId="work" />));
  expect(container.textContent).toContain("Launch: Unobserved"); expect(container.textContent).toContain("Restart requirement unavailable");
  expect(container.textContent).toContain("Source manifest: unavailable"); expect(container.textContent).not.toContain("Environment build: Built");
  vi.mocked(developmentRequest).mockRejectedValue(new Error("Read permission revoked"));
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(container.textContent).toContain("Read permission revoked"); expect(container.textContent).not.toContain("Demo App");
});
it("clears restart notice after restart and preserves the same preview URL", async () => {
  vi.useFakeTimers(); vi.mocked(developmentRequest).mockResolvedValue(reply({ restartRequired: true }));
  await act(async () => root.render(<WorkspacePreviews workspaceId="work" />));
  const preview = container.querySelector('a[href="http://core.test/open"]')!.getAttribute("href");
  vi.mocked(developmentRequest).mockResolvedValue(reply({ restartRequired: false, development: { reloadMode: "application-managed", manifestState: "current", restartRequired: false }, launchProgress: { stage: "ready", buildState: "reused", changedAt: "2026-10-16T12:01:00Z" } }));
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(container.textContent).toContain("Environment build: Reused"); expect(container.textContent).not.toContain("Restart required");
  expect(container.querySelector('a[href="http://core.test/open"]')!.getAttribute("href")).toBe(preview);
});
