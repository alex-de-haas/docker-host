// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionSandboxes } from "./session-sandboxes";
import { workspaceAction } from "@/lib/assistant-api";

vi.mock("@/lib/assistant-api", () => ({ workspaceAction: vi.fn() }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.mocked(workspaceAction).mockReset().mockImplementation(async (_id, action) => action === "environment-list" ? { environments: [] } : { instances: [] });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const environment = { id: "child", label: "Test Core", state: "running", mode: "dev", port: 4100, previewUrl: "http://core.test" };
const mount = () => act(async () => root.render(<SessionSandboxes sessionId="one" />));
const open = () => act(async () => {
  const details = container.querySelector("details")!;
  details.open = true; details.dispatchEvent(new Event("toggle"));
});
const button = (label: string) => [...container.querySelectorAll("button")].find(item => item.textContent === label)!;

it("waits for both independent inventory reads before reporting a confirmed empty session", async () => {
  const sandbox = deferred<unknown>(), child = deferred<unknown>();
  vi.mocked(workspaceAction).mockImplementation((_id, action) => action === "environment-list" ? child.promise : sandbox.promise);
  await mount(); await open();
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading sandbox inventory…");
  expect(container.querySelector(".hosty-grid-loader")).not.toBeNull();
  expect(container.textContent).not.toContain("No sandbox instances");
  await act(async () => child.resolve({ environments: [] }));
  expect(container.textContent).toContain("Loading sandbox inventory…");
  expect(container.textContent).not.toContain("No sandbox instances");
  await act(async () => sandbox.resolve({ instances: [] }));
  expect(container.textContent).toContain("No sandbox instances in this session");
  expect(container.textContent).not.toContain("Loading sandbox inventory");
});

it("keeps a failed inventory distinct from empty and retries only the existing read operations", async () => {
  vi.mocked(workspaceAction).mockImplementation(async (_id, action) => {
    if (action === "environment-list") throw new Error("Child inventory denied");
    return { instances: [] };
  });
  await mount(); await open();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Child inventory denied");
  expect(container.textContent).not.toContain("No sandbox instances");
  const sandbox = deferred<unknown>(), child = deferred<unknown>();
  vi.mocked(workspaceAction).mockImplementation((_id, action) => action === "environment-list" ? child.promise : sandbox.promise);
  await act(async () => button("Retry inventory").click());
  expect(container.textContent).toContain("Loading sandbox inventory…");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(vi.mocked(workspaceAction).mock.calls.every(([session, action]) => session === "one" && ["sandbox-list", "environment-list"].includes(action))).toBe(true);
  await act(async () => { child.resolve({ environments: [] }); sandbox.resolve({ instances: [] }); });
  expect(container.textContent).toContain("No sandbox instances in this session");
});

it.each([
  { status: 401, body: undefined },
  { status: 500, body: undefined },
  { status: 200, body: {} },
])("does not treat a $status child response without an app inventory as no preview endpoints", async response => {
  const apps = deferred<unknown>();
  vi.mocked(workspaceAction).mockImplementation(async (_id, action) => action === "environment-list" ? { environments: [environment] }
    : action === "environment-api" ? apps.promise : { instances: [] });
  await mount(); await open();
  expect(container.textContent).toContain("Loading application previews…");
  expect(container.textContent).not.toContain("No running application preview endpoints");
  await act(async () => apps.resolve(response));
  expect(container.textContent).toContain("Application previews unavailable.");
  expect(container.textContent).not.toContain("Loading application previews");
  expect(container.textContent).not.toContain("No running application preview endpoints");
  expect(container.querySelector('a[href="http://core.test/login"]')).not.toBeNull();
});

it("recovers child observations from unavailable to a confirmed empty endpoint set and then the existing preview link", async () => {
  let applicationResponse: unknown = { status: 503 };
  vi.mocked(workspaceAction).mockImplementation(async (_id, action) => action === "environment-list" ? { environments: [environment] }
    : action === "environment-api" ? applicationResponse : { instances: [] });
  await mount(); await open();
  expect(container.textContent).toContain("Application previews unavailable.");
  applicationResponse = { status: 200, body: { apps: [] } };
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(container.textContent).toContain("No running application preview endpoints.");
  expect(container.textContent).not.toContain("Application previews unavailable.");
  applicationResponse = { status: 200, body: { apps: [{ displayName: "Test App", entryEndpoint: "web", entryPath: "/view?mode=test",
    endpoints: [{ key: "web", browserOrigin: "http://app.test", availability: "running" }] }] } };
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(container.querySelector('a[href="http://app.test/view?mode=test"]')?.textContent).toBe("Open Test App");
  expect(container.textContent).not.toContain("No running application preview endpoints");
  const call = vi.mocked(workspaceAction).mock.calls.find(([, action]) => action === "environment-api")!;
  expect(call).toEqual(["one", "environment-api", { environmentId: "child", method: "GET", path: "/api/apps" }]);
});

it("clears stale child links on inventory failure without claiming that the session is empty", async () => {
  let failed = false;
  vi.mocked(workspaceAction).mockImplementation(async (_id, action) => {
    if (action === "environment-list") {
      if (failed) throw new Error("Child inventory disconnected");
      return { environments: [environment] };
    }
    if (action === "environment-api") return { status: 200, body: { apps: [{ displayName: "Test App", entryEndpoint: "web",
      endpoints: [{ key: "web", browserOrigin: "http://app.test", availability: "running" }] }] } };
    return { instances: [] };
  });
  await mount(); await open();
  expect(container.querySelector('a[href="http://app.test/"]')).not.toBeNull();
  failed = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Child inventory disconnected");
  expect(container.querySelector('a[href="http://app.test/"]')).toBeNull();
  expect(container.textContent).not.toContain("No sandbox instances");
});

it("does not start child reads after the inventory disclosure closes", async () => {
  const child = deferred<unknown>();
  vi.mocked(workspaceAction).mockImplementation((_id, action) => action === "environment-list" ? child.promise : Promise.resolve({ instances: [] }));
  await mount(); await open();
  await act(async () => {
    const details = container.querySelector("details")!;
    details.open = false; details.dispatchEvent(new Event("toggle"));
  });
  await act(async () => child.resolve({ environments: [environment] }));
  expect(vi.mocked(workspaceAction).mock.calls.filter(([, action]) => action === "environment-api")).toHaveLength(0);
  expect(container.querySelector('a[href="http://core.test/login"]')).toBeNull();
});
