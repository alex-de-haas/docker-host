// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MissingPermissionsNotice } from "./permissions-react";
vi.mock("./browser-auth", () => ({ appFetch: (...args: unknown[]) => fetch(...args as Parameters<typeof fetch>) }));
let root: Root;
let container: HTMLDivElement;
const missing = { hostRole: "host.admin", appId: "own", corePublicOrigin: "http://core.test", permissions: { required: ["apps.read"], optional: [], granted: [] } };
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render(body = missing) {
  const fetchMock = vi.fn().mockImplementation(async () => Response.json(body)); vi.stubGlobal("fetch", fetchMock);
  await act(async () => root.render(<MissingPermissionsNotice />));
  return fetchMock;
}
it("refreshes on focus after approval and removes the notice", async () => {
  const fetchMock = await render();
  expect(container.textContent).toContain("Request permissions");
  fetchMock.mockImplementation(async () => Response.json({ ...missing, permissions: { ...missing.permissions, granted: ["apps.read"] } }));
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(container.textContent).toBe("");
});
it("requests review from the click, polls while pending, and dismisses until remount", async () => {
  const fetchMock = await render();
  vi.useFakeTimers();
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  await act(async () => (container.querySelector("button") as HTMLButtonElement).click());
  expect(open).toHaveBeenCalledWith("http://core.test/install/permissions/own", "_blank", "noopener,noreferrer");
  expect(container.textContent).toContain("Review permissions in Core");
  const calls = fetchMock.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(fetchMock.mock.calls.length).toBeGreaterThan(calls);
  await act(async () => (Array.from(container.querySelectorAll("button")).find(b => b.textContent === "Dismiss")!).click());
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(container.textContent).toBe("");
});
it("does not render administrator actions for ordinary viewers", async () => {
  await render({ ...missing, hostRole: "host.user" });
  expect(container.textContent).toBe("");
});
it("shows unsupported required names without review button", async () => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json({ ...missing, permissions: { ...missing.permissions, unsupportedRequired: ["old.name"] } })));
  await act(async () => root.render(<MissingPermissionsNotice />));
  expect(container.textContent).toContain("Update the app or Core");
  expect(container.textContent).not.toContain("Request permissions");
});
