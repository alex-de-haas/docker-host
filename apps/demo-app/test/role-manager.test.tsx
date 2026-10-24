import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { AppRoleManager } from "../src/components/AppRoleManager";
import type { DemoRoleManagementSnapshot } from "../src/lib/app-role-management";

const request = vi.hoisted(() => vi.fn());
vi.mock("@hosty-sdk/app/browser-auth", () => ({ appFetch: request }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

function snapshot(canManage = true): DemoRoleManagementSnapshot {
  return { generatedAt: "2026-10-24T00:00:00Z", canManage,
    current: { principal: "admin", role: "admin", roleLabel: "Admin", source: "sandbox-scenario", assignment: null, permissions: [], canManageRoles: canManage },
    assignments: [], roleSourceLabels: { "host-assignment": "Host assignment", "sandbox-scenario": "Sandbox scenario" },
    roles: ["viewer", "operator", "admin"].map(role => ({ role: role as "viewer" | "operator" | "admin", label: role, description: role, permissions: [] })),
    directory: { status: "ok", error: null },
    users: ["First", "Second"].map(name => ({ id: name, displayName: name, email: `${name}@example.test`, hostRole: null, sandboxRole: "viewer",
      appRole: { userId: name, role: "viewer", roleLabel: "Viewer", source: "host-assignment", assignment: null, permissions: [] } })),
  };
}
async function choose(name: string, role: string) {
  const trigger = container.querySelector<HTMLButtonElement>(`[aria-label="App role for ${name}"]`)!;
  await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(item => item.textContent === role)!;
  expect(option).toBeDefined();
  await act(async () => option.click());
}
function save(name: string) {
  const row = container.querySelector(`[aria-label="App role for ${name}"]`)!.closest("label")!.parentElement!;
  return Array.from(row.querySelectorAll<HTMLButtonElement>("button")).find(item => item.textContent?.trim() === "Save")!;
}

it("keeps another user's draft through a save and displays the pending operation", async () => {
  await act(async () => root.render(<AppRoleManager initialSnapshot={snapshot()} />));
  await choose("First", "operator"); await choose("Second", "admin");
  let resolve!: (value: Response) => void;
  request.mockReturnValue(new Promise<Response>(done => { resolve = done; }));
  await act(async () => save("First").click());
  expect(container.textContent).toContain("Saving…");
  expect(container.querySelector(".hosty-grid-loader")).not.toBeNull();
  expect(request).toHaveBeenCalledWith("/api/roles/First", expect.objectContaining({ method: "PUT", body: JSON.stringify({ role: "operator" }) }));
  const updated = snapshot();
  updated.users[0].appRole.assignment = { userId: "First", role: "operator", updatedBy: "admin", updatedAt: updated.generatedAt };
  await act(async () => resolve(Response.json({ snapshot: updated })));
  expect(container.querySelector('[aria-label="App role for Second"]')?.textContent).toBe("admin");
  expect(save("Second").disabled).toBe(false);
  expect(container.textContent).toContain("Sandbox · viewer");
});

it("adopts another administrator's returned role for an unrelated clean row", async () => {
  const initial = snapshot();
  initial.users[1].appRole.assignment = { userId: "Second", role: "viewer", updatedBy: "admin", updatedAt: initial.generatedAt };
  await act(async () => root.render(<AppRoleManager initialSnapshot={initial} />));
  expect(save("Second").disabled).toBe(true);
  await choose("First", "operator");
  const updated = snapshot();
  updated.users[0].appRole.assignment = { userId: "First", role: "operator", updatedBy: "admin", updatedAt: updated.generatedAt };
  updated.users[1].appRole.assignment = { userId: "Second", role: "admin", updatedBy: "other-admin", updatedAt: updated.generatedAt };
  request.mockResolvedValue(Response.json({ snapshot: updated }));
  await act(async () => save("First").click());
  expect(container.querySelector('[aria-label="App role for Second"]')?.textContent).toBe("admin");
  expect(save("Second").disabled).toBe(true);
  expect(request).toHaveBeenCalledTimes(1);
});

it("retains the selected role after a refused update and never enables read-only mutations", async () => {
  await act(async () => root.render(<AppRoleManager initialSnapshot={snapshot()} />));
  await choose("First", "operator");
  request.mockResolvedValue(Response.json({ error: { message: "Role update refused" } }, { status: 403 }));
  await act(async () => save("First").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Role update refused");
  expect(container.querySelector('[aria-label="App role for First"]')?.textContent).toBe("operator");
  await act(async () => root.render(<AppRoleManager key="read-only" initialSnapshot={snapshot(false)} />));
  expect(container.textContent).toContain("Your app access is read only");
  expect(container.querySelector<HTMLButtonElement>('[aria-label="App role for First"]')?.disabled).toBe(true);
  expect(save("First").disabled).toBe(true);
  expect(request).toHaveBeenCalledTimes(1);
});
