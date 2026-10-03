import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppPermissions } from "../src/app/shell/dialogs/app-permissions";
import type { AppPermissionObservation, CoreApp } from "../src/app/shell/types";
const api = vi.hoisted(() => ({ prepare: vi.fn(), submit: vi.fn(), status: vi.fn(), refresh: vi.fn(), send: vi.fn() }));
vi.mock("../src/app/shell/shell-context", () => ({ useShellActions: () => ({ coreOrigin: "https://core.test", shellAppId: "legacy", sendCsrfJson: api.send, refresh: api.refresh }) }));
vi.mock("@hosty-sdk/app/install", () => ({ InstallationError: class extends Error {}, createInstallationClient: () => api, openInstallationConfirmation: () => null, showInstallationConfirmation: vi.fn() }));
let root: Root, container: HTMLDivElement;
let state: AppPermissionObservation;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state = { status: "known", required: ["apps.skills.read"], optional: ["providers.speech-to-text"], acceptedRequired: [], acceptedOptional: [], granted: [], missingRequired: ["apps.skills.read"], reviewRequired: true, unconfirmedRoles: [], error: null, checkedAt: "now", descriptions: { "apps.skills.read": "Read skills" } };
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(state)));
  api.prepare.mockImplementation(async () => ({ id: "review", permissionPlan: state }));
  api.submit.mockResolvedValue({ id: "review", approvalUrl: "https://core.test/install/confirm/review" });
  api.status.mockResolvedValue({ status: "denied" });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(<AppPermissions app={{ id: "legacy" } as CoreApp} />));
const review = () => act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "Change permissions")!.click());
it("shows permission grants read-only, including Shell's own optional permissions", async () => {
  state = { ...state, optional: ["providers.speech-to-text", "providers.assistant"],
    acceptedOptional: ["providers.speech-to-text"], granted: ["providers.speech-to-text"] };
  await render();
  expect(container.textContent).toContain("Required permissions need approval");
  expect(container.textContent).toContain("Read skills");
  expect(container.textContent).toContain("Optional · Allowed");
  expect(container.textContent).toContain("Optional · Not allowed");
  expect(container.querySelectorAll('[role="switch"], input[type="checkbox"]')).toHaveLength(0);
});
it("opens Core for Shell itself without submitting selections, with a blocked-popup fallback", async () => {
  const popup = vi.spyOn(window, "open").mockReturnValue(null);
  await render();
  await review();
  expect(popup).toHaveBeenCalledWith("https://core.test/install/permissions/legacy", "_blank", "noopener,noreferrer");
  expect(api.prepare).not.toHaveBeenCalled();
  expect(api.submit).not.toHaveBeenCalled();
  expect(container.querySelector("a")?.href).toBe("https://core.test/install/permissions/legacy");
  popup.mockRestore();
});
it("refreshes grants and dashboard on returning from Core", async () => {
  await render();
  state = { ...state, granted: state.required, missingRequired: [], reviewRequired: false };
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(api.refresh).toHaveBeenCalledOnce();
  expect(container.textContent).not.toContain("Required permissions need approval");
  expect(container.textContent).toContain("Required · Allowed");
});
it("shows explicit empty and unavailable states", async () => {
  state = { ...state, required: [], optional: [], missingRequired: [], reviewRequired: false };
  await render();
  expect(container.textContent).toContain("requests no Core permissions");
  state = { ...state, status: "stale", error: "Invalid JSON" };
  await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "Refresh")!.click());
  expect(container.textContent).toContain("The manifest could not be checked");
  expect([...container.querySelectorAll("button")].some(b => b.textContent === "Change permissions")).toBe(false);
});

it("explains unsupported requirements and does not offer an impossible approval", async () => {
  state = { ...state, required: ["removed.permission"], unsupportedRequired: ["removed.permission"], missingRequired: [] };
  await render();
  expect(container.textContent).toContain("Core does not support these required permissions: removed.permission");
  expect(container.textContent).not.toContain("Required permissions need approval");
  const button = [...container.querySelectorAll("button")].find(b => b.textContent === "Change permissions")!;
  expect(button.disabled).toBe(true);
  await review();
  expect(api.prepare).not.toHaveBeenCalled();
});

it("opens Core-owned permission review for another app without asking Shell to change its grants", async () => {
  const popup = vi.spyOn(window, "open").mockReturnValue(null);
  await act(async () => root.render(<AppPermissions app={{ id: "other.app" } as CoreApp} />));
  expect(container.querySelectorAll('[role="switch"]')).toHaveLength(0);
  await review();
  expect(popup).toHaveBeenCalledWith("https://core.test/install/permissions/other.app", "_blank", "noopener,noreferrer");
  expect(api.prepare).not.toHaveBeenCalled(); expect(api.send).not.toHaveBeenCalled(); popup.mockRestore();
});
