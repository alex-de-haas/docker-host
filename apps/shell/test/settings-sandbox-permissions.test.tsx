import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SandboxLaunchPermissions } from "../src/app/shell/pages/settings-sandbox-permissions";

const mocks = vi.hoisted(() => ({ read: vi.fn(), send: vi.fn() }));
vi.mock("../src/app/shell/core-transport.js", () => ({ fetchCore: mocks.read }));
const grant = { id: "grant", appId: "hosty.harness", label: "Harness QA", mode: "current", state: "active", target: "Installed Core" };
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.read.mockReset(); mocks.send.mockReset();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function mount() { await act(async () => root.render(<SandboxLaunchPermissions coreOrigin="https://core.test" apps={[]} sendCsrfJson={mocks.send} />)); }
it("keeps saved launch permissions revocable after the last sandbox is deleted", async () => {
  let revoked = false;
  mocks.read.mockImplementation(async () => Response.json({ environments: [], consents: revoked ? [] : [grant] }));
  mocks.send.mockImplementation(async () => { revoked = true; return Response.json({ environments: [], consents: [] }); });
  await mount();
  expect(container.textContent).toContain("Harness QA");
  const revoke = [...container.querySelectorAll("button")].find(button => button.textContent === "Revoke permission")!;
  await act(async () => revoke.click());
  expect(mocks.send).toHaveBeenCalledWith("https://core.test/api/core-environments/consents/grant/revoke", {});
  expect(container.textContent).toBe("");
});
it("does not render another empty panel when no saved permissions exist", async () => {
  mocks.read.mockResolvedValue(Response.json({ environments: [], consents: [] }));
  await mount();
  expect(container.textContent).toBe("");
});
it("shows a failed permission read instead of claiming an empty inventory", async () => {
  mocks.read.mockResolvedValue(Response.json({ message: "Permission denied" }, { status: 403 }));
  await mount();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Permission denied");
});
it("retains a saved permission and its error when revocation cannot be confirmed", async () => {
  mocks.read.mockResolvedValue(Response.json({ consents: [grant] }));
  mocks.send.mockRejectedValue(new Error("Connection lost"));
  await mount();
  await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Revoke permission")!.click());
  expect(container.textContent).toContain("Harness QA");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Connection lost");
});
