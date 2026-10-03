import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { DemoSession, DemoResource, useDemoAuth } from "../src/components/DemoSession";

const request = vi.hoisted(() => vi.fn());
vi.mock("@hosty-sdk/app/browser-auth", () => ({ appFetch: request }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
function User() { return <p>{useDemoAuth().appSession.displayName}</p>; }

it("loads protected user content after app authentication through the SDK transport", async () => {
  let resolve!: (value: Response) => void;
  request.mockReturnValue(new Promise<Response>(done => { resolve = done; }));
  await act(async () => root.render(<DemoSession><User /></DemoSession>));
  expect(container.textContent).toBe("Loading app data…");
  expect(request).toHaveBeenCalledWith("/api/auth/identity", expect.objectContaining({ cache: "no-store" }));
  await act(async () => resolve(Response.json({ appSession: { displayName: "Current app user" } })));
  expect(container.textContent).toBe("Current app user");
});

it("does not expose protected children on a refused session and permits retry after an outage", async () => {
  request.mockResolvedValueOnce(Response.json({ error: { message: "Core unavailable" } }, { status: 503 }));
  await act(async () => root.render(<DemoResource<{ name: string }> path="/api/roles">{value => <p>{value.name}</p>}</DemoResource>));
  expect(container.textContent).toContain("Core unavailable");
  request.mockResolvedValueOnce(Response.json({ name: "Restored" }));
  await act(async () => container.querySelector("button")!.click());
  expect(container.textContent).toBe("Restored");
});
